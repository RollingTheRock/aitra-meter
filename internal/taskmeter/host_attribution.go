package taskmeter

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/aitra-ai/aitra-meter/internal/provider"
)

var (
	// ErrHardwareUnavailable is returned when SPBM hwmon telemetry is not available on this system.
	ErrHardwareUnavailable = errors.New("SPBM hardware energy telemetry is unavailable")

	// ErrCounterDiscontinuity is returned when an energy counter decreases or rolls over unexpectedly.
	ErrCounterDiscontinuity = errors.New("SPBM energy counter discontinuity or wrap detected")
)

// HostEnergyMeasurement is the structured CPU host-level physical and attributed billing for a task.
type HostEnergyMeasurement struct {
	TaskID      string    `json:"task_id"`
	PID         int       `json:"pid"`
	StartedAt   time.Time `json:"started_at"`
	FinishedAt  time.Time `json:"finished_at"`
	DurationSec float64   `json:"duration_seconds"`

	// Physical baseline and package energy (Joules / Watts)
	IdlePowerWatts   float64 `json:"idle_power_watts"`      // Baseline resting power (P_idle)
	RawPackageJoules float64 `json:"raw_package_joules"`    // SPBM physical total meter delta (E_end - E_start)
	BaselineJoules   float64 `json:"baseline_joules"`       // Baseline energy deducted (IdlePower * Duration)
	ActiveJoules     float64 `json:"active_dynamic_joules"` // Real dynamic energy: max(0, Raw - Baseline)

	// Process activity and final attribution
	AgentCPURatio    float64 `json:"agent_cpu_ratio"`  // Agent Process Ticks / Total System Active Ticks
	AttributedJoules float64 `json:"agent_cpu_joules"` // Final attributed CPU joules: ActiveJoules * AgentCPURatio

	Status string `json:"status"` // "ok" | "warning_low_power" | "process_not_found"
}

// taskSession tracks an in-flight measurement window for an agent task.
type taskSession struct {
	TaskID          string
	PID             int
	StartedAt       time.Time
	IdlePowerWatts  float64
	StartSysTicks   uint64
	StartAgentTicks uint64
	ProcessFound    bool
}

// HostTracker coordinates host energy measurement, baseline deduction, and process CPU attribution.
type HostTracker struct {
	provider provider.HostEnergyProvider
	reader   *ProcReader
	procRoot string
	mu       sync.Mutex
	sessions map[string]*taskSession
	now      func() time.Time
}

// TrackerOption configures a HostTracker.
type TrackerOption func(*HostTracker)

// WithProcFS sets a custom procfs root path (primarily for hermetic testing).
func WithProcFS(root string) TrackerOption {
	return func(ht *HostTracker) {
		ht.procRoot = root
		ht.reader = NewProcReader(root)
	}
}

// WithNowFunc sets a custom clock function (for deterministic testing).
func WithNowFunc(fn func() time.Time) TrackerOption {
	return func(ht *HostTracker) {
		ht.now = fn
	}
}

// NewHostTracker creates a new HostTracker using the provided HostEnergyProvider.
func NewHostTracker(p provider.HostEnergyProvider, opts ...TrackerOption) *HostTracker {
	ht := &HostTracker{
		provider: p,
		procRoot: "/proc",
		reader:   NewProcReader("/proc"),
		sessions: make(map[string]*taskSession),
		now:      time.Now,
	}
	for _, opt := range opts {
		opt(ht)
	}
	return ht
}

// Start begins a task measurement session: locks idle power baseline, starts provider window,
// and samples initial CPU ticks.
func (t *HostTracker) Start(taskID string, pid int) error {
	ctx := context.Background()

	// Zero-Mock Fail Fast: check if hardware telemetry is available
	if t.provider == nil || !t.provider.Available(ctx) {
		return fmt.Errorf("%w: driver or device not available", ErrHardwareUnavailable)
	}

	idleWatts, err := t.provider.IdlePower(ctx)
	if err != nil {
		if errors.Is(err, provider.ErrHostEnergyUnavailable) {
			return fmt.Errorf("%w: %v", ErrHardwareUnavailable, err)
		}
		return fmt.Errorf("sample idle power: %w", err)
	}

	if err := t.provider.BeginWindow(ctx, taskID); err != nil {
		if errors.Is(err, provider.ErrHostEnergyUnavailable) {
			return fmt.Errorf("%w: %v", ErrHardwareUnavailable, err)
		}
		return fmt.Errorf("begin energy window: %w", err)
	}

	// Sample system and process ticks
	startSysTicks, _, err := t.reader.SystemActiveTicks()
	if err != nil {
		return fmt.Errorf("sample system active ticks: %w", err)
	}

	startAgentTicks, found, err := t.reader.ProcessTreeTicks(pid)
	if err != nil {
		return fmt.Errorf("sample process tree ticks: %w", err)
	}

	sess := &taskSession{
		TaskID:          taskID,
		PID:             pid,
		StartedAt:       t.now(),
		IdlePowerWatts:  idleWatts,
		StartSysTicks:   startSysTicks,
		StartAgentTicks: startAgentTicks,
		ProcessFound:    found,
	}

	t.mu.Lock()
	t.sessions[taskID] = sess
	t.mu.Unlock()

	return nil
}

// Stop closes the measurement window, performs baseline deduction, calculates process attribution,
// and produces a HostEnergyMeasurement.
func (t *HostTracker) Stop(taskID string) (HostEnergyMeasurement, error) {
	ctx := context.Background()
	finishedAt := t.now()

	t.mu.Lock()
	sess, ok := t.sessions[taskID]
	if ok {
		delete(t.sessions, taskID)
	}
	t.mu.Unlock()

	if !ok {
		return HostEnergyMeasurement{}, fmt.Errorf("task session %q not found or already stopped", taskID)
	}

	durationSec := finishedAt.Sub(sess.StartedAt).Seconds()
	if durationSec < 0 {
		durationSec = 0
	}

	rawJoules, err := t.provider.EndWindow(ctx, taskID)
	if err != nil {
		if errors.Is(err, ErrCounterDiscontinuity) {
			return HostEnergyMeasurement{}, ErrCounterDiscontinuity
		}
		return HostEnergyMeasurement{}, fmt.Errorf("end energy window: %w", err)
	}
	if rawJoules < 0 {
		return HostEnergyMeasurement{}, fmt.Errorf("%w: raw package joules negative (%f)", ErrCounterDiscontinuity, rawJoules)
	}

	// Sample terminating ticks
	endSysTicks, _, err := t.reader.SystemActiveTicks()
	if err != nil {
		return HostEnergyMeasurement{}, fmt.Errorf("sample end system ticks: %w", err)
	}

	endAgentTicks, foundEnd, err := t.reader.ProcessTreeTicks(sess.PID)
	if err != nil {
		return HostEnergyMeasurement{}, fmt.Errorf("sample end process ticks: %w", err)
	}

	// Baseline energy deduction formula: Delta E_active = max(0, Delta E_pkg - P_idle * Delta t)
	baselineJoules := sess.IdlePowerWatts * durationSec
	activeJoules := rawJoules - baselineJoules

	status := "ok"
	if !sess.ProcessFound && !foundEnd {
		status = "process_not_found"
	} else if activeJoules < 0 {
		activeJoules = 0
		status = "warning_low_power"
	}

	// Ratio calculation: Agent Process Ticks / Total System Active Ticks
	var agentRatio float64
	if status == "process_not_found" {
		agentRatio = 0.0
	} else {
		var deltaSysTicks float64
		if endSysTicks > sess.StartSysTicks {
			deltaSysTicks = float64(endSysTicks - sess.StartSysTicks)
		}

		var deltaAgentTicks float64
		if endAgentTicks > sess.StartAgentTicks {
			deltaAgentTicks = float64(endAgentTicks - sess.StartAgentTicks)
		}

		// Zero-division guard: ensure deltaSysTicks > 0
		if deltaSysTicks <= 0 {
			agentRatio = 0.0
		} else {
			agentRatio = deltaAgentTicks / deltaSysTicks
			if agentRatio > 1.0 {
				agentRatio = 1.0
			} else if agentRatio < 0.0 {
				agentRatio = 0.0
			}
		}
	}

	attributedJoules := activeJoules * agentRatio

	return HostEnergyMeasurement{
		TaskID:           taskID,
		PID:              sess.PID,
		StartedAt:        sess.StartedAt,
		FinishedAt:       finishedAt,
		DurationSec:      durationSec,
		IdlePowerWatts:   sess.IdlePowerWatts,
		RawPackageJoules: rawJoules,
		BaselineJoules:   baselineJoules,
		ActiveJoules:     activeJoules,
		AgentCPURatio:    agentRatio,
		AttributedJoules: attributedJoules,
		Status:           status,
	}, nil
}
