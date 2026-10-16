// Package taskmeter accumulates per-task (agent-session) energy from
// per-request token usage joined against the meter's live per-model J/token.
//
// A "task" is one logical agent run — in the demo integration, one pi-agent
// session — identified by an opaque task ID that rides either in the request
// path (/t/{taskID}/v1/...) or the X-Aitra-Task-Id header. Requests carrying
// no identity are booked under DefaultTaskID rather than rejected, so
// unlabelled traffic is still proxied and never silently dropped.
//
// Energy is attributed by token share: each LLM call contributes
// output_tokens × J/token(model, now). This is proportional attribution over
// batched serving, not physical isolation — the same contract as the meter's
// host-energy split — and is labelled as such in every bill.
package taskmeter

import (
	"sort"
	"sync"
	"time"
)

// joulesPerKWh converts J → kWh for the cost/carbon derivations.
const joulesPerKWh = 3_600_000.0

// Efficiency is one model's current J/token reading, resolved by the caller
// (the gateway polls the aggregation service). SystemJPT is 0 when host energy
// is not measured; GPU-only J/token is then the only truthful number and
// system figures are omitted — absent, never zero.
type Efficiency struct {
	JPT       float64 // GPU-only joules per output token
	SystemJPT float64 // (GPU+host) joules per output token; 0 = unmeasured
	At        time.Time
}

// EfficiencySource resolves the current efficiency for a model.
// Implementations may cache; a zero-value Efficiency means "unknown".
type EfficiencySource interface {
	Efficiency(model string) Efficiency
}

// CallRecord is one billed LLM request within a task.
type CallRecord struct {
	At           time.Time `json:"at"`
	Model        string    `json:"model"`
	PromptTokens uint64    `json:"prompt_tokens"`
	OutputTokens uint64    `json:"output_tokens"`
	GPUJoules    float64   `json:"gpu_joules"`
	SystemJoules float64   `json:"system_joules,omitempty"` // 0 when host unmeasured
	JPTUsed      float64   `json:"j_per_token_used"`
	// Provisional marks a call whose energy or token count is not exact:
	// either JPT was unknown at booking time (JPTUsed=0, joules booked as
	// zero) or the output token count was estimated from stream chunks
	// because the backend never sent a usage block. The call is still billed
	// and its tokens are real; the flag says "do not treat this number as
	// exact yet".
	Provisional bool `json:"provisional,omitempty"`
}

// ModelUsage is a task's accumulated usage of one model.
type ModelUsage struct {
	Model        string  `json:"model"`
	Calls        uint64  `json:"calls"`
	PromptTokens uint64  `json:"prompt_tokens"`
	OutputTokens uint64  `json:"output_tokens"`
	GPUJoules    float64 `json:"gpu_joules"`
	SystemJoules float64 `json:"system_joules,omitempty"`
}

// TaskBill is the structured bill for one task: the GW-001 §3.1 contract
// fields plus the meter's detail fields (activity window, attribution
// method, per-model rollup) kept as additive extras.
type TaskBill struct {
	TaskID       string       `json:"task_id"`
	StartedAt    time.Time    `json:"started_at"`
	LastActivity time.Time    `json:"last_activity"`
	TotalCalls   uint64       `json:"total_calls"`
	PromptTokens uint64       `json:"prompt_tokens"`
	OutputTokens uint64       `json:"output_tokens"`
	GPUJoules    float64      `json:"gpu_joules"`    // Σ output_tokens × JPT_live
	SystemJoules float64      `json:"system_joules"` // host-inclusive; 0 = unmeasured
	CostUSD      float64      `json:"cost_usd,omitempty"`
	GCO2         float64      `json:"gco2,omitempty"`
	Attribution  string       `json:"attribution_method,omitempty"`
	ByModel      []ModelUsage `json:"by_model,omitempty"`
	Breakdown    []CallRecord `json:"breakdown"`
	Provisional  bool         `json:"provisional,omitempty"` // any call was provisional
}

// Meter accumulates task energy. Safe for concurrent use.
type Meter struct {
	src EfficiencySource

	// CostPerKWh and GCO2PerKWh derive the bill lines; zero disables the
	// derivation and the fields stay absent (site-unconfigured contract).
	CostPerKWh float64
	GCO2PerKWh float64

	// MaxBreakdown bounds the per-task call log (default 50) so a long-running
	// agent's bill stays bounded in memory; the oldest calls are dropped first.
	MaxBreakdown int

	mu    sync.Mutex
	tasks map[string]*taskState
}

type taskState struct {
	TaskBill
	byModel map[string]*ModelUsage
	// provisional is sticky: once any call was booked provisionally the bill
	// says so even after that call ages out of the bounded breakdown.
	provisional      bool
	promSystemJoules float64
	hostJoules       float64
}

// New creates a Meter reading efficiencies from src.
func New(src EfficiencySource) *Meter {
	return &Meter{src: src, MaxBreakdown: 50, tasks: make(map[string]*taskState)}
}

// Record books one LLM call against a task and returns the call's bill.
// estimated marks an output token count derived from stream chunk counting
// rather than a backend usage block — the call is then provisional.
// A model with no known efficiency books tokens but zero joules — the tokens
// are real and the energy is unknown; recording zero energy for an unknown
// model would be wrong, so JPTUsed=0 marks the call as unmetered.
func (m *Meter) Record(taskID, model string, promptTokens, outputTokens uint64, estimated bool) CallRecord {
	now := time.Now()
	eff := m.src.Efficiency(model)

	c := CallRecord{
		At:           now,
		Model:        model,
		PromptTokens: promptTokens,
		OutputTokens: outputTokens,
		JPTUsed:      eff.JPT,
		Provisional:  estimated || eff.JPT <= 0,
	}
	c.GPUJoules = float64(outputTokens) * eff.JPT
	if eff.SystemJPT > 0 {
		c.SystemJoules = float64(outputTokens) * eff.SystemJPT
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.tasks[taskID]
	if !ok {
		st = &taskState{
			TaskBill: TaskBill{TaskID: taskID, StartedAt: now, Attribution: "token-share"},
			byModel:  make(map[string]*ModelUsage),
		}
		m.tasks[taskID] = st
	}
	st.LastActivity = now
	st.TotalCalls++
	st.PromptTokens += promptTokens
	st.OutputTokens += outputTokens
	st.GPUJoules += c.GPUJoules
	st.promSystemJoules += c.SystemJoules
	if st.promSystemJoules > 0 {
		st.SystemJoules = st.promSystemJoules + st.hostJoules
	} else if st.hostJoules > 0 {
		st.SystemJoules = st.GPUJoules + st.hostJoules
	}
	if c.Provisional {
		st.provisional = true
	}

	mu, ok := st.byModel[model]
	if !ok {
		mu = &ModelUsage{Model: model}
		st.byModel[model] = mu
	}
	mu.Calls++
	mu.PromptTokens += promptTokens
	mu.OutputTokens += outputTokens
	mu.GPUJoules += c.GPUJoules
	mu.SystemJoules += c.SystemJoules

	st.Breakdown = append(st.Breakdown, c)
	if max := m.MaxBreakdown; max > 0 && len(st.Breakdown) > max {
		st.Breakdown = st.Breakdown[len(st.Breakdown)-max:]
	}
	return c
}

// billed fills the derived cost/carbon lines on a copied bill.
// Billed from system joules when measured, else GPU-only — never zero-pad.
func (m *Meter) billed(st *taskState) TaskBill {
	t := st.TaskBill
	t.Breakdown = make([]CallRecord, len(st.Breakdown))
	copy(t.Breakdown, st.Breakdown)
	t.ByModel = make([]ModelUsage, 0, len(st.byModel))
	for _, mu := range st.byModel {
		t.ByModel = append(t.ByModel, *mu)
	}
	sort.Slice(t.ByModel, func(i, j int) bool { return t.ByModel[i].GPUJoules > t.ByModel[j].GPUJoules })
	t.Provisional = st.provisional

	if st.promSystemJoules > 0 {
		t.SystemJoules = st.promSystemJoules + st.hostJoules
	} else if st.hostJoules > 0 {
		t.SystemJoules = t.GPUJoules + st.hostJoules
	}

	j := t.SystemJoules
	if j == 0 {
		j = t.GPUJoules
	}
	if m.CostPerKWh > 0 {
		t.CostUSD = j / joulesPerKWh * m.CostPerKWh
	}
	if m.GCO2PerKWh > 0 {
		t.GCO2 = j / joulesPerKWh * m.GCO2PerKWh
	}
	return t
}

// Get returns one task's bill (detail view, per-call breakdown included),
// or ok=false.
func (m *Meter) Get(taskID string) (TaskBill, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.tasks[taskID]
	if !ok {
		return TaskBill{}, false
	}
	return m.billed(st), true
}

// List returns task summaries (per-call breakdown drained to an empty array,
// per-model rollup omitted), most recently active first.
func (m *Meter) List() []TaskBill {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]TaskBill, 0, len(m.tasks))
	for _, st := range m.tasks {
		t := m.billed(st)
		t.ByModel = nil
		t.Breakdown = []CallRecord{}
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastActivity.After(out[j].LastActivity) })
	return out
}

// AddHostEnergy adds attributed host/CPU dynamic joules to a task's energy bill.
func (m *Meter) AddHostEnergy(taskID string, cpuJoules float64) {
	if m == nil || cpuJoules <= 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.tasks[taskID]
	if !ok {
		now := time.Now()
		st = &taskState{
			TaskBill: TaskBill{TaskID: taskID, StartedAt: now, LastActivity: now, Attribution: "token-share+host-attribution"},
			byModel:  make(map[string]*ModelUsage),
		}
		m.tasks[taskID] = st
	}
	st.hostJoules += cpuJoules
	st.Attribution = "token-share+host-attribution"
	if st.promSystemJoules > 0 {
		st.SystemJoules = st.promSystemJoules + st.hostJoules
	} else {
		st.SystemJoules = st.GPUJoules + st.hostJoules
	}
}
