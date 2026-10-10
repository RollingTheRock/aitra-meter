package taskmeter

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/aitra-ai/aitra-meter/internal/provider/inference/promtext"
)

// PromSource resolves per-model efficiency from the aggregation service's
// Prometheus text endpoint (GET /metrics): aitra_j_per_token (GPU-only) and
// aitra_system_j_per_token (GPU+host). It reads the live window from the
// service that computes it, so no Prometheus server is required.
//
// Readings are polled on an interval and served from cache. A model whose
// gauge currently reads 0 (quiet window — the aggregation loop zeroes gauges
// when a model stops serving) keeps its last non-zero reading for up to
// Staleness: the task's own request is what ends the quiet spell, and billing
// it at the zeroed gauge would price real tokens at zero energy. Past
// Staleness the reading is treated as unknown and calls book provisionally.
type PromSource struct {
	MetricsURL string        // e.g. http://127.0.0.1:8080/metrics
	Interval   time.Duration // poll cadence (default 10s)
	Staleness  time.Duration // how long a last-known-good reading stays usable (default 5m)
	Client     *http.Client

	mu  sync.RWMutex
	eff map[string]Efficiency
}

// NewPromSource creates a PromSource and starts its poll loop.
func NewPromSource(ctx context.Context, metricsURL string) *PromSource {
	s := &PromSource{
		MetricsURL: metricsURL,
		Interval:   10 * time.Second,
		Staleness:  5 * time.Minute,
		Client:     &http.Client{Timeout: 8 * time.Second},
		eff:        make(map[string]Efficiency),
	}
	go s.loop(ctx)
	return s
}

// Efficiency implements EfficiencySource.
func (s *PromSource) Efficiency(model string) Efficiency {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e := s.eff[model]
	if time.Since(e.At) > s.Staleness {
		return Efficiency{}
	}
	return e
}

func (s *PromSource) loop(ctx context.Context) {
	s.poll(ctx)
	t := time.NewTicker(s.Interval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			s.poll(ctx)
		case <-ctx.Done():
			return
		}
	}
}

func (s *PromSource) poll(ctx context.Context) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.MetricsURL, nil)
	if err != nil {
		return
	}
	resp, err := s.Client.Do(req)
	if err != nil {
		return // keep last-known-good; Staleness bounds how long
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		return
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return
	}
	series := promtext.Parse(strings.Split(string(b), "\n"))
	gpu := byModelMax(series, "aitra_j_per_token")
	system := byModelMax(series, "aitra_system_j_per_token")

	s.mu.Lock()
	defer s.mu.Unlock()
	for model, jpt := range gpu {
		if jpt <= 0 {
			continue // quiet window — keep last non-zero reading
		}
		e := Efficiency{JPT: jpt, At: time.Now()}
		if sys := system[model]; sys > 0 {
			e.SystemJPT = sys
		}
		s.eff[model] = e
	}
}

// byModelMax returns model → max(value) across series of one metric.
// Max, not sum: the same model can appear under several label sets
// (workload splits, hardware relabels) that are the same physical series.
// LabelValue keeps the label set intact, so a series is never collapsed onto
// the wrong name (see promtext's package doc).
func byModelMax(series map[string][]promtext.Sample, metric string) map[string]float64 {
	out := make(map[string]float64)
	for _, sample := range series[metric] {
		model := promtext.LabelValue(sample.Labels, "model")
		if model == "" {
			continue
		}
		if sample.Value > out[model] {
			out[model] = sample.Value
		}
	}
	return out
}
