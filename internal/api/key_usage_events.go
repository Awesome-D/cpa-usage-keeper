package api

import (
	"fmt"
	"net/http"
	"time"

	"cpa-usage-keeper/internal/service"
	servicedto "cpa-usage-keeper/internal/service/dto"
	"cpa-usage-keeper/internal/timeutil"

	"github.com/gin-gonic/gin"
)

type keyUsageEventPayload struct {
	ID              string                 `json:"id,omitempty"`
	Timestamp       string                 `json:"timestamp"`
	Model           string                 `json:"model"`
	ResponseModel   string                 `json:"response_model,omitempty"`
	ReasoningEffort string                 `json:"reasoning_effort,omitempty"`
	ServiceTier     string                 `json:"service_tier,omitempty"`
	Endpoint        string                 `json:"endpoint,omitempty"`
	RequestID       string                 `json:"request_id,omitempty"`
	Failed          bool                   `json:"failed"`
	StatusCode      *int                   `json:"status_code,omitempty"`
	Stream          *bool                  `json:"stream,omitempty"`
	LatencyMS       int64                  `json:"latency_ms"`
	TTFTMS          *int64                 `json:"ttft_ms,omitempty"`
	Tokens          usageEventTokenPayload `json:"tokens"`
	CostUSD         float64                `json:"cost_usd"`
	CostAvailable   bool                   `json:"cost_available"`
}

type keyUsageEventsResponse struct {
	Events     []keyUsageEventPayload `json:"events"`
	TotalCount int64                  `json:"total_count"`
	Page       int                    `json:"page"`
	PageSize   int                    `json:"page_size"`
	TotalPages int                    `json:"total_pages"`
	NextCursor string                 `json:"next_cursor,omitempty"`
	HasMore    bool                   `json:"has_more"`
}

func registerKeyUsageEventsRoute(router gin.IRoutes, usageProvider service.UsageProvider) {
	router.GET("/key-events", func(c *gin.Context) {
		session, _, ok := activeAPIKeyViewerContext(c)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
			return
		}
		if usageProvider == nil {
			c.JSON(http.StatusOK, keyUsageEventsResponse{
				Events:   []keyUsageEventPayload{},
				Page:     1,
				PageSize: servicedto.DefaultUsageEventsLimit,
			})
			return
		}

		filter, err := parseUsageFilterQuery(c.Request, timeutil.NormalizeStorageTime(time.Now()))
		if err != nil {
			writeUsageFilterParseError(c, err)
			return
		}
		// Key viewer 的查询范围由会话绑定的 Key 决定，忽略任何跨身份筛选。
		filter.APIKeyID = fmt.Sprintf("%d", session.CPAAPIKeyID)
		filter.Source = ""
		filter.AuthIndex = ""
		filter.AuthType = ""

		rows, err := usageProvider.ListUsageEvents(c.Request.Context(), filter)
		if err != nil {
			writeInternalError(c, "list key usage events failed", err)
			return
		}

		nextCursor := ""
		if filter.CursorMode && rows.HasMore && len(rows.Events) > 0 {
			lastEvent := rows.Events[len(rows.Events)-1]
			nextCursor = encodeUsageEventsCursor(lastEvent.Timestamp, lastEvent.ID)
		}
		c.JSON(http.StatusOK, keyUsageEventsResponse{
			Events:     buildKeyUsageEventsPayload(rows.Events),
			TotalCount: rows.TotalCount,
			Page:       rows.Page,
			PageSize:   rows.PageSize,
			TotalPages: rows.TotalPages,
			NextCursor: nextCursor,
			HasMore:    rows.HasMore,
		})
	})
}

func buildKeyUsageEventsPayload(rows []servicedto.UsageEventRecord) []keyUsageEventPayload {
	if len(rows) == 0 {
		return []keyUsageEventPayload{}
	}
	result := make([]keyUsageEventPayload, 0, len(rows))
	for _, row := range rows {
		result = append(result, keyUsageEventPayload{
			ID:              fmt.Sprintf("%d", row.ID),
			Timestamp:       timeutil.FormatStorageTime(row.Timestamp),
			Model:           row.Model,
			ResponseModel:   row.ResponseModel,
			ReasoningEffort: row.ReasoningEffort,
			ServiceTier:     row.ServiceTier,
			Endpoint:        row.Endpoint,
			RequestID:       row.RequestID,
			Failed:          row.Failed,
			StatusCode:      row.StatusCode,
			Stream:          row.Stream,
			LatencyMS:       row.LatencyMS,
			TTFTMS:          row.TTFTMS,
			Tokens: usageEventTokenPayload{
				InputTokens:         row.InputTokens,
				OutputTokens:        row.OutputTokens,
				ReasoningTokens:     row.ReasoningTokens,
				CacheReadTokens:     row.CacheReadTokens,
				CacheCreationTokens: row.CacheCreationTokens,
				TotalTokens:         row.TotalTokens,
			},
			CostUSD:       row.CostUSD,
			CostAvailable: row.CostAvailable,
		})
	}
	return result
}
