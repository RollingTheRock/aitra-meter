package taskmeter

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aitra-ai/aitra-meter/internal/provider"
	"go.uber.org/zap"
)

type mockHostProvider struct {
	available   bool
	idlePower   float64
	windowDelta float64
	err         error
}

func (m *mockHostProvider) BeginWindow(ctx context.Context, windowID string) error {
	return m.err
}

func (m *mockHostProvider) EndWindow(ctx context.Context, windowID string) (float64, error) {
	if m.err != nil {
		return 0, m.err
	}
	return m.windowDelta, nil
}

func (m *mockHostProvider) IdlePower(ctx context.Context) (float64, error) {
	if m.err != nil {
		return 0, m.err
	}
	return m.idlePower, nil
}

func (m *mockHostProvider) Domains(ctx context.Context) ([]provider.Device, error) {
	return nil, nil
}

func (m *mockHostProvider) Available(ctx context.Context) bool {
	return m.available
}

func (m *mockHostProvider) Name() string {
	return "mock-host-provider"
}

func TestMeter_AddHostEnergy(t *testing.T) {
	src := staticSource{"m1": {JPT: 2.0}}
	m := New(src)

	m.Record("task-1", "m1", 10, 50, false)
	bill, ok := m.Get("task-1")
	if !ok {
		t.Fatal("expected task-1 to exist")
	}
	if bill.GPUJoules != 100.0 {
		t.Fatalf("expected 100.0 GPUJoules, got %f", bill.GPUJoules)
	}

	m.AddHostEnergy("task-1", 25.5)
	bill2, ok := m.Get("task-1")
	if !ok {
		t.Fatal("expected task-1 to exist")
	}
	if bill2.SystemJoules != 125.5 {
		t.Fatalf("expected SystemJoules 125.5 (100 GPU + 25.5 CPU), got %f", bill2.SystemJoules)
	}

	// Turn 2: verify multi-turn GPU and CPU accumulation does not drop GPUJoules
	m.Record("task-1", "m1", 10, 50, false)
	m.AddHostEnergy("task-1", 10.0)
	bill3, ok := m.Get("task-1")
	if !ok {
		t.Fatal("expected task-1 to exist")
	}
	if bill3.GPUJoules != 200.0 {
		t.Fatalf("expected 200.0 GPUJoules, got %f", bill3.GPUJoules)
	}
	if bill3.SystemJoules != 235.5 {
		t.Fatalf("expected SystemJoules 235.5 (200 GPU + 35.5 CPU), got %f", bill3.SystemJoules)
	}
}

func TestCPUHandler_StartAndStop(t *testing.T) {
	pid := 4242
	procDir := t.TempDir()

	writeProcStat(t, procDir, 100, 0, 100, 800, 0, 0, 0, 0)
	writeProcPidStat(t, procDir, pid, "testproc", 1, 10, 10, 0, 0)

	now := time.Now()
	clock := func() time.Time { return now }

	mockP := &mockHostProvider{
		available:   true,
		idlePower:   100.0, // 100W idle
		windowDelta: 500.0, // 500J raw
	}

	tracker := NewHostTracker(mockP, WithProcFS(procDir), WithNowFunc(clock))
	meter := New(staticSource{})
	logger := zap.NewNop()

	handler := NewCPUHandler(tracker, meter, logger)

	// 1. Start session
	startBody, _ := json.Marshal(map[string]any{"pid": pid})
	reqStart := httptest.NewRequest(http.MethodPost, "/tasks/task-42/cpu/start", bytes.NewReader(startBody))
	recStart := httptest.NewRecorder()

	handler.HandleStart(recStart, reqStart, "task-42")
	if recStart.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", recStart.Code, recStart.Body.String())
	}

	// Advance clock by 2s -> baseline = 100W * 2s = 200J. Active = 500 - 200 = 300J.
	now = now.Add(2 * time.Second)

	// Advance ticks so agent ratio is 1.0 (deltaSys = 100, deltaAgent = 100)
	writeProcStat(t, procDir, 150, 0, 150, 800, 0, 0, 0, 0)
	writeProcPidStat(t, procDir, pid, "testproc", 1, 60, 60, 0, 0)

	// 2. Stop session
	reqStop := httptest.NewRequest(http.MethodPost, "/tasks/task-42/cpu/stop", nil)
	recStop := httptest.NewRecorder()

	handler.HandleStop(recStop, reqStop, "task-42")
	if recStop.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", recStop.Code, recStop.Body.String())
	}

	var meas HostEnergyMeasurement
	if err := json.Unmarshal(recStop.Body.Bytes(), &meas); err != nil {
		t.Fatalf("unmarshal measurement: %v", err)
	}

	if meas.TaskID != "task-42" {
		t.Errorf("expected TaskID task-42, got %q", meas.TaskID)
	}
	if meas.ActiveJoules != 300.0 {
		t.Errorf("expected ActiveJoules 300.0, got %f", meas.ActiveJoules)
	}
	if meas.AttributedJoules != 300.0 {
		t.Errorf("expected AttributedJoules 300.0, got %f", meas.AttributedJoules)
	}

	// Check meter was updated
	bill, ok := meter.Get("task-42")
	if !ok {
		t.Fatal("expected task-42 in meter")
	}
	if bill.SystemJoules != 300.0 {
		t.Errorf("expected meter SystemJoules 300.0, got %f", bill.SystemJoules)
	}
}

func TestCPUHandler_Unavailable(t *testing.T) {
	// Tracker is nil
	handler := NewCPUHandler(nil, nil, zap.NewNop())

	reqStart := httptest.NewRequest(http.MethodPost, "/tasks/task-none/cpu/start", nil)
	recStart := httptest.NewRecorder()
	handler.HandleStart(recStart, reqStart, "task-none")

	if recStart.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", recStart.Code)
	}

	reqStop := httptest.NewRequest(http.MethodPost, "/tasks/task-none/cpu/stop", nil)
	recStop := httptest.NewRecorder()
	handler.HandleStop(recStop, reqStop, "task-none")

	if recStop.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", recStop.Code)
	}
}

func TestCPUHandler_NotFound(t *testing.T) {
	mockP := &mockHostProvider{available: true}
	tracker := NewHostTracker(mockP)
	handler := NewCPUHandler(tracker, nil, zap.NewNop())

	reqStop := httptest.NewRequest(http.MethodPost, "/tasks/not-exist/cpu/stop", nil)
	recStop := httptest.NewRecorder()
	handler.HandleStop(recStop, reqStop, "not-exist")

	if recStop.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", recStop.Code)
	}
}
