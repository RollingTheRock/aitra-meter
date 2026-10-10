package taskmeter

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"go.uber.org/zap"
)

type staticSource map[string]Efficiency

func (s staticSource) Efficiency(model string) Efficiency { return s[model] }

// waitForBill polls the meter until the bill for taskID satisfies ok, or
// fails the test. Booking for streamed calls completes just after the last
// chunk reaches the client, so the poll absorbs that scheduling gap.
func waitForBill(t *testing.T, m *Meter, taskID string, ok func(TaskBill) bool) TaskBill {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		got, found := m.Get(taskID)
		if found && ok(got) {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("bill for %q never reached expected state; last = %+v (found=%v)", taskID, got, found)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestStreamingTaskProxyAccounting drives a streaming completion through the
// real proxy against a fake SSE backend and asserts the whole chain: the
// injected include_usage, byte-exact chunk passthrough, and the deterministic
// bill (22 output tokens × a 2 J/token reading = 44 J, not provisional).
func TestStreamingTaskProxyAccounting(t *testing.T) {
	const (
		chunk1 = `data: {"choices":[{"delta":{"content":"Hel"}}]}` + "\n\n"
		chunk2 = `data: {"choices":[{"delta":{"content":"lo"}}]}` + "\n\n"
		usage  = `data: {"usage":{"prompt_tokens":11,"completion_tokens":22}}` + "\n\n"
		done   = "data: [DONE]\n\n"
	)

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"include_usage":true`) {
			t.Errorf("stream request missing injected include_usage: %s", body)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization header not preserved, got %q", got)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, chunk1+chunk2+usage+done)
	}))
	defer backend.Close()

	bu, _ := url.Parse(backend.URL)
	meter := New(staticSource{"m1": {JPT: 2, At: time.Now()}})
	proxy := &Proxy{Meter: meter, Backends: map[string]*url.URL{"m1": bu}, Log: zap.NewNop()}
	srv := httptest.NewServer(proxy)
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/t/demo_test/v1/chat/completions",
		strings.NewReader(`{"model":"m1","messages":[{"role":"user","content":"hi"}],"stream":true}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer test-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	stream, _ := io.ReadAll(resp.Body)
	resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
	if want := chunk1 + chunk2 + usage + done; string(stream) != want {
		t.Errorf("stream not passed through byte-exact:\n got: %q\nwant: %q", stream, want)
	}

	got := waitForBill(t, meter, "demo_test", func(b TaskBill) bool { return b.TotalCalls == 1 })
	if got.PromptTokens != 11 || got.OutputTokens != 22 {
		t.Errorf("tokens = %d/%d, want 11/22", got.PromptTokens, got.OutputTokens)
	}
	if got.GPUJoules != 44 {
		t.Errorf("gpu joules = %v, want 44", got.GPUJoules)
	}
	if got.Provisional {
		t.Error("usage-block call must not be provisional")
	}
	if len(got.Breakdown) != 1 {
		t.Fatalf("breakdown = %+v, want 1 call", got.Breakdown)
	}
	if c := got.Breakdown[0]; c.Model != "m1" || c.JPTUsed != 2 || c.GPUJoules != 44 {
		t.Errorf("breakdown[0] = %+v, want model m1 @2 J/token, 44 J", c)
	}
	if _, ok := meter.Get("some_other_task"); ok {
		t.Error("unrelated task must not exist")
	}
}

// TestStreamingFallbackCountsDeltasWhenNoUsage covers backends that never send
// a usage block (include_usage unsupported) or clients that abort mid-stream:
// the proxy falls back to counting delta chunks and marks the call provisional.
func TestStreamingFallbackCountsDeltasWhenNoUsage(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"role":"assistant"}}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"a"}}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"b"}}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"c"}}]}`+"\n\n")
		fmt.Fprint(w, `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`+"\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer backend.Close()

	bu, _ := url.Parse(backend.URL)
	meter := New(staticSource{"m1": {JPT: 2, At: time.Now()}})
	proxy := &Proxy{Meter: meter, Backends: map[string]*url.URL{"m1": bu}, Log: zap.NewNop()}
	srv := httptest.NewServer(proxy)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/t/counted/v1/chat/completions", "application/json",
		strings.NewReader(`{"model":"m1","stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close() //nolint:errcheck

	got := waitForBill(t, meter, "counted", func(b TaskBill) bool { return b.TotalCalls == 1 })
	if got.OutputTokens != 3 {
		t.Errorf("estimated output tokens = %d, want 3 (one per content delta)", got.OutputTokens)
	}
	if got.PromptTokens != 0 {
		t.Errorf("estimated call prompt tokens = %d, want 0 (unknown)", got.PromptTokens)
	}
	if got.GPUJoules != 6 {
		t.Errorf("gpu joules = %v, want 6", got.GPUJoules)
	}
	if !got.Provisional {
		t.Error("delta-counted call must be provisional")
	}
}

// TestNonStreamingTaskAccounting books a JSON completion scoped by the
// X-Aitra-Task-Id header and checks both passthrough and the bill.
func TestNonStreamingTaskAccounting(t *testing.T) {
	const payload = `{"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":60}}`
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, payload)
	}))
	defer backend.Close()

	bu, _ := url.Parse(backend.URL)
	meter := New(staticSource{"m1": {JPT: 2, At: time.Now()}})
	proxy := &Proxy{Meter: meter, Backends: map[string]*url.URL{"m1": bu}, Log: zap.NewNop()}
	srv := httptest.NewServer(proxy)
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"m1"}`))
	req.Header.Set(TaskIDHeader, "session-9")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close() //nolint:errcheck
	if string(b) != payload {
		t.Errorf("body not passed through: %s", b)
	}

	got, ok := meter.Get("session-9")
	if !ok || got.TotalCalls != 1 || got.OutputTokens != 60 || got.GPUJoules != 120 {
		t.Errorf("bill = %+v (ok=%v), want 1 call / 60 tok / 120 J", got, ok)
	}
	if got.Provisional {
		t.Error("usage-block call must not be provisional")
	}
}

// TestTaskDefaultFallback: a request with no task identity anywhere is
// proxied normally and booked under task_default — never rejected.
func TestTaskDefaultFallback(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}`)
	}))
	defer backend.Close()

	bu, _ := url.Parse(backend.URL)
	meter := New(staticSource{"m1": {JPT: 5, At: time.Now()}})
	proxy := &Proxy{Meter: meter, Backends: map[string]*url.URL{"m1": bu}, Log: zap.NewNop()}
	srv := httptest.NewServer(proxy)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/v1/chat/completions", "application/json",
		strings.NewReader(`{"model":"m1"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("no-identity status = %d, want 200 (proxy, never reject)", resp.StatusCode)
	}

	got, ok := meter.Get(DefaultTaskID)
	if !ok || got.TotalCalls != 1 || got.OutputTokens != 2 || got.GPUJoules != 10 {
		t.Errorf("default bill = %+v (ok=%v), want 1 call / 2 tok / 10 J", got, ok)
	}
}

// TestBackendDownReturns502JSON: a dead inference backend surfaces immediately
// as a 502 with a machine-readable JSON reason, and books nothing.
func TestBackendDownReturns502JSON(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := dead.URL
	dead.Close() // nothing listens on the port anymore

	bu, _ := url.Parse(deadURL)
	meter := New(staticSource{"m1": {JPT: 2, At: time.Now()}})
	proxy := &Proxy{Meter: meter, Backends: map[string]*url.URL{"m1": bu}, Log: zap.NewNop()}
	srv := httptest.NewServer(proxy)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/t/dead/v1/chat/completions", "application/json",
		strings.NewReader(`{"model":"m1"}`))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var body map[string]string
	if err := json.Unmarshal(b, &body); err != nil {
		t.Fatalf("502 body is not JSON: %s", b)
	}
	if body["error"] != "backend unreachable" || body["backend"] == "" || body["detail"] == "" {
		t.Errorf("502 body = %v, want error/backend/detail", body)
	}
	if _, ok := meter.Get("dead"); ok {
		t.Error("failed call must not be booked")
	}
}

// TestBackendErrorStatusPassesThrough: upstream 4xx/5xx responses pass through
// with status intact and are not metered.
func TestBackendErrorStatusPassesThrough(t *testing.T) {
	const payload = `{"error":{"message":"bad request"}}`
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, payload)
	}))
	defer backend.Close()

	bu, _ := url.Parse(backend.URL)
	meter := New(staticSource{"m1": {JPT: 2, At: time.Now()}})
	proxy := &Proxy{Meter: meter, Backends: map[string]*url.URL{"m1": bu}, Log: zap.NewNop()}
	srv := httptest.NewServer(proxy)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/t/errcase/v1/chat/completions", "application/json",
		strings.NewReader(`{"model":"m1"}`))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 passthrough", resp.StatusCode)
	}
	if string(b) != payload {
		t.Errorf("error body not passed through: %s", b)
	}
	if _, ok := meter.Get("errcase"); ok {
		t.Error("errored call must not be booked")
	}
}

// TestProxyDefaultBackend: a model with no route goes to the default backend
// (the local SGLang/llama.cpp server) and is still metered; without a default
// backend the unknown model is rejected with JSON.
func TestProxyDefaultBackend(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}`)
	}))
	defer backend.Close()
	bu, _ := url.Parse(backend.URL)

	meter := New(staticSource{"auto": {JPT: 4, At: time.Now()}})
	proxy := &Proxy{Meter: meter, Backends: map[string]*url.URL{}, DefaultBackend: bu, Log: zap.NewNop()}
	srv := httptest.NewServer(proxy)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/t/agentsvc-42/v1/chat/completions", "application/json",
		strings.NewReader(`{"model":"auto"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("default-backend status = %d, want 200", resp.StatusCode)
	}
	got, ok := meter.Get("agentsvc-42")
	if !ok || got.TotalCalls != 1 || got.OutputTokens != 5 || got.GPUJoules != 20 {
		t.Errorf("bill = %+v (ok=%v), want 1 call / 5 tok / 20 J", got, ok)
	}

	// No default backend → unknown model rejected with JSON.
	strict := httptest.NewServer(&Proxy{Meter: meter, Backends: map[string]*url.URL{}, Log: zap.NewNop()})
	defer strict.Close()
	r2, _ := http.Post(strict.URL+"/t/x/v1/chat/completions", "application/json", strings.NewReader(`{"model":"auto"}`))
	if r2.StatusCode != http.StatusNotFound {
		t.Errorf("strict mode status = %d, want 404", r2.StatusCode)
	}
	b2, _ := io.ReadAll(r2.Body)
	r2.Body.Close() //nolint:errcheck
	var e2 map[string]string
	if err := json.Unmarshal(b2, &e2); err != nil || e2["error"] == "" {
		t.Errorf("strict mode body = %s, want {\"error\":...}", b2)
	}
}

func TestMeterAccumulatesAcrossModels(t *testing.T) {
	m := New(staticSource{
		"small": {JPT: 2, SystemJPT: 3, At: time.Now()},
		"large": {JPT: 10, At: time.Now()},
	})
	m.CostPerKWh = 0.36 // makes 3.6e6 J cost exactly $0.36
	m.GCO2PerKWh = 400

	m.Record("task-1", "small", 100, 50, false) // gpu 100 J, system 150 J
	m.Record("task-1", "large", 200, 30, false) // gpu 300 J, system unmeasured
	m.Record("task-2", "small", 10, 10, false)  // separate task

	got, ok := m.Get("task-1")
	if !ok {
		t.Fatal("task-1 missing")
	}
	if got.TotalCalls != 2 || got.OutputTokens != 80 {
		t.Errorf("calls/tokens = %d/%d, want 2/80", got.TotalCalls, got.OutputTokens)
	}
	if got.GPUJoules != 400 {
		t.Errorf("gpu joules = %v, want 400", got.GPUJoules)
	}
	// System total only includes measured calls — never zero-padded.
	if got.SystemJoules != 150 {
		t.Errorf("system joules = %v, want 150", got.SystemJoules)
	}
	if len(got.ByModel) != 2 || got.ByModel[0].Model != "large" {
		t.Errorf("by_model = %+v, want large first (most energy)", got.ByModel)
	}
	if got.Attribution != "token-share" {
		t.Errorf("attribution = %q", got.Attribution)
	}
	if got.Provisional {
		t.Error("fully measured task must not be provisional")
	}
	// Cost/carbon derive from system joules when measured: 150 J.
	if want := 150.0 / 3.6e6 * 0.36; got.CostUSD < want-1e-12 || got.CostUSD > want+1e-12 {
		t.Errorf("cost = %v, want %v", got.CostUSD, want)
	}
	if want := 150.0 / 3.6e6 * 400; got.GCO2 < want-1e-9 || got.GCO2 > want+1e-9 {
		t.Errorf("gco2 = %v, want %v", got.GCO2, want)
	}
	if len(got.Breakdown) != 2 {
		t.Errorf("breakdown len = %d, want 2", len(got.Breakdown))
	}
	if len(m.List()) != 2 {
		t.Errorf("List() = %d tasks, want 2", len(m.List()))
	}
}

func TestMeterUnknownModelBooksTokensNotEnergy(t *testing.T) {
	m := New(staticSource{})
	c := m.Record("t", "mystery", 5, 7, false)
	if c.GPUJoules != 0 || c.JPTUsed != 0 {
		t.Errorf("unknown model must book zero joules with JPTUsed=0, got %+v", c)
	}
	if !c.Provisional {
		t.Error("unknown JPT must mark the call provisional")
	}
	got, _ := m.Get("t")
	if got.OutputTokens != 7 {
		t.Errorf("tokens must still be booked: %d", got.OutputTokens)
	}
	if !got.Provisional {
		t.Error("bill with an unmetered call must be provisional")
	}
}

// TestMeterEstimatedCallsAreProvisional: a delta-counted call with a real JPT
// reading still books real energy, but stays flagged as estimated.
func TestMeterEstimatedCallsAreProvisional(t *testing.T) {
	m := New(staticSource{"m": {JPT: 3, At: time.Now()}})
	c := m.Record("t", "m", 0, 10, true)
	if c.GPUJoules != 30 {
		t.Errorf("gpu joules = %v, want 30", c.GPUJoules)
	}
	if !c.Provisional {
		t.Error("estimated call must be provisional")
	}
}

func TestSplitTaskPath(t *testing.T) {
	for _, tc := range []struct{ in, id, rest string }{
		{"/t/sandbox-42/v1/chat/completions", "sandbox-42", "/v1/chat/completions"},
		{"/v1/completions", "", "/v1/completions"},
		{"/t//v1/x", "", "/t//v1/x"},
		{"/t/abc", "", "/t/abc"},
	} {
		id, rest := splitTaskPath(tc.in)
		if id != tc.id || rest != tc.rest {
			t.Errorf("splitTaskPath(%q) = %q,%q want %q,%q", tc.in, id, rest, tc.id, tc.rest)
		}
	}
}

func TestEnsureIncludeUsage(t *testing.T) {
	out, changed := ensureIncludeUsage([]byte(`{"model":"m","stream":true}`))
	if !changed || !strings.Contains(string(out), `"include_usage":true`) {
		t.Errorf("include_usage not injected: %s", out)
	}
	_, changed = ensureIncludeUsage([]byte(`{"stream_options":{"include_usage":true}}`))
	if changed {
		t.Error("already-opted-in body must not change")
	}
}

// TestPromSourceScrape covers the text-endpoint read path: per-model max across
// label sets, the system gauge, quiet-window (zero) retention, staleness
// expiry, and scrape-failure retention.
func TestPromSourceScrape(t *testing.T) {
	var mu sync.Mutex
	body := `
# HELP aitra_j_per_token Joules per output token for the current measurement window.
# TYPE aitra_j_per_token gauge
aitra_j_per_token{namespace="demo",workload="pi",model="a",hardware="gb10",precision="fp8",calibration_tier="measured",attribution_method="token-share"} 1.5
aitra_j_per_token{namespace="demo",workload="pi2",model="a",hardware="gb10",precision="fp8",calibration_tier="measured",attribution_method="token-share"} 2.5
aitra_j_per_token{model="b"} 3
aitra_j_per_token{model="c"} 0
aitra_j_per_token{hardware="NVIDIA GB10",model="d"} 7
aitra_system_j_per_token{model="a",host_provider="rapl"} 4
aitra_system_j_per_token{model="b",host_provider="rapl"} 0
`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		fmt.Fprint(w, body)
	}))
	defer srv.Close()

	s := &PromSource{
		MetricsURL: srv.URL,
		Interval:   time.Hour,
		Staleness:  time.Minute,
		Client:     srv.Client(),
		eff:        make(map[string]Efficiency),
	}
	s.poll(context.Background())

	if e := s.Efficiency("a"); e.JPT != 2.5 || e.SystemJPT != 4 {
		t.Errorf("model a = %+v, want JPT 2.5 (max across label sets) and system 4", e)
	}
	if e := s.Efficiency("b"); e.JPT != 3 || e.SystemJPT != 0 {
		t.Errorf("model b = %+v, want JPT 3 and no system reading", e)
	}
	if e := s.Efficiency("c"); e.JPT != 0 {
		t.Errorf("zero-reading model must be unknown, got %+v", e)
	}
	// Real-world shape: the aggregation labels hardware="NVIDIA GB10" — a
	// quoted value containing a space. The series must stay keyed to its model.
	if e := s.Efficiency("d"); e.JPT != 7 {
		t.Errorf("spaced label value must not lose the model key, got %+v", e)
	}

	// Quiet window: gauges drop to zero → last non-zero reading is kept.
	mu.Lock()
	body = "aitra_j_per_token{model=\"a\"} 0\n"
	mu.Unlock()
	s.poll(context.Background())
	if e := s.Efficiency("a"); e.JPT != 2.5 {
		t.Errorf("quiet window must keep last-known-good, got %+v", e)
	}

	// Past staleness the reading is treated as unknown.
	s.mu.Lock()
	e := s.eff["a"]
	e.At = time.Now().Add(-2 * time.Minute)
	s.eff["a"] = e
	s.mu.Unlock()
	if e := s.Efficiency("a"); e.JPT != 0 {
		t.Errorf("stale reading must be unknown, got %+v", e)
	}

	// Scrape failure keeps the cache (staleness still bounds usability).
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := dead.URL
	dead.Close()
	s.MetricsURL = deadURL
	s.poll(context.Background())
	s.mu.RLock()
	_, cached := s.eff["a"]
	s.mu.RUnlock()
	if !cached {
		t.Error("scrape failure must not evict the cache")
	}
}
