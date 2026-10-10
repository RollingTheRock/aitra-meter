//go:build linux

package taskmeter

import (
	"context"
	"fmt"
	"os/exec"
	"testing"
	"time"

	"github.com/aitra-ai/aitra-meter/internal/provider"
	_ "github.com/aitra-ai/aitra-meter/internal/provider/hostenergy/gracespark"
)

func TestRealGB10HardwareAttribution(t *testing.T) {
	p, err := provider.NewHostEnergy("grace-spark-hwmon", map[string]string{
		"path": "/sys/class/hwmon",
	})
	if err != nil {
		t.Skipf("grace-spark-hwmon not available: %v", err)
	}
	if !p.Available(context.Background()) {
		t.Skip("grace-spark-hwmon hardware not available on this machine")
	}

	tracker := NewHostTracker(p)

	// 1. Run real Sleep 3s process (sleeps 10s, measured for 3s)
	sleepCmd := exec.Command("sleep", "10")
	if err := sleepCmd.Start(); err != nil {
		t.Fatalf("start sleep command: %v", err)
	}
	defer func() {
		_ = sleepCmd.Process.Kill()
		_ = sleepCmd.Wait()
	}()

	if err := tracker.Start("real-sleep-3s", sleepCmd.Process.Pid); err != nil {
		t.Fatalf("tracker.Start sleep failed: %v", err)
	}
	time.Sleep(3 * time.Second)
	sleepRes, err := tracker.Stop("real-sleep-3s")
	if err != nil {
		t.Fatalf("tracker.Stop sleep failed: %v", err)
	}

	// 2. Run real Busy CPU 3s process (Python floating-point busy loop, measured for 3s)
	busyCmd := exec.Command("python3", "-c", "x = 0.0\nwhile True:\n    x = (x + 1.2345) * 1.00001\n")
	if err := busyCmd.Start(); err != nil {
		t.Fatalf("start busy command: %v", err)
	}
	defer func() {
		_ = busyCmd.Process.Kill()
		_ = busyCmd.Wait()
	}()

	if err := tracker.Start("real-busy-3s", busyCmd.Process.Pid); err != nil {
		t.Fatalf("tracker.Start busy failed: %v", err)
	}
	time.Sleep(3 * time.Second)
	busyRes, err := tracker.Stop("real-busy-3s")
	if err != nil {
		t.Fatalf("tracker.Stop busy failed: %v", err)
	}

	table := fmt.Sprintf("\n"+
		"========================================================================================================\n"+
		"| REAL GB10 SPBM HARDWARE TEST RESULT (xpark)\n"+
		"| %-12s | %-10s | %-12s | %-12s | %-12s | %-10s | %-14s |\n"+
		"|--------------|------------|--------------|--------------|--------------|------------|----------------|\n"+
		"| %-12s | %-9.2fs | %-10.2f W | %-10.2f J | %-10.2f J | %-10.4f | %-12.2f J |\n"+
		"| %-12s | %-9.2fs | %-10.2f W | %-10.2f J | %-10.2f J | %-10.4f | %-12.2f J |\n"+
		"========================================================================================================\n",
		"Workload", "Duration", "Idle Power", "Raw SPBM", "Baseline", "CPU Ratio", "Attributed J",
		"Sleep 3s", sleepRes.DurationSec, sleepRes.IdlePowerWatts, sleepRes.RawPackageJoules, sleepRes.BaselineJoules, sleepRes.AgentCPURatio, sleepRes.AttributedJoules,
		"Busy CPU 3s", busyRes.DurationSec, busyRes.IdlePowerWatts, busyRes.RawPackageJoules, busyRes.BaselineJoules, busyRes.AgentCPURatio, busyRes.AttributedJoules,
	)
	t.Log(table)

	if sleepRes.AttributedJoules > 1.0 {
		t.Errorf("Sleep process should attribute ~0 J, got %f", sleepRes.AttributedJoules)
	}
	if busyRes.AttributedJoules <= 0.0 {
		t.Errorf("Busy CPU process should attribute positive J, got %f", busyRes.AttributedJoules)
	}
}
