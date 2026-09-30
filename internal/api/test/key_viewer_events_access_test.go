package test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	. "cpa-usage-keeper/internal/api"
	"cpa-usage-keeper/internal/auth"
	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/service"
	servicedto "cpa-usage-keeper/internal/service/dto"
)

type keyViewerUsageEventsStub struct {
	*usageEventsStub
	ownsEvent      bool
	ownershipCalls int
	ownedEventID   int64
	ownedAPIKeyID  string
}

func (s *keyViewerUsageEventsStub) UsageEventBelongsToAPIKey(_ context.Context, eventID int64, apiKeyID string) (bool, error) {
	s.ownershipCalls++
	s.ownedEventID = eventID
	s.ownedAPIKeyID = apiKeyID
	return s.ownsEvent, nil
}

func newKeyViewerEventsRouter(
	t *testing.T,
	key entities.CPAAPIKey,
	usage *keyViewerUsageEventsStub,
	logs service.RequestLogProvider,
) (*ginRouterHarness, string) {
	t.Helper()
	sessions := auth.NewSessionManager(time.Hour)
	token, _, err := sessions.CreateAPIKeyViewerWithSource(key.ID, auth.SessionSourceStandard)
	if err != nil {
		t.Fatalf("create API key viewer session: %v", err)
	}
	keyProvider := &authCPAAPIKeyStub{row: key}
	config := AuthConfig{Enabled: true, LoginPassword: "secret", SessionTTL: time.Hour}
	router := NewRouter(nil, nil, usage, nil, config, NewAuthHandler(config, sessions), "", OptionalProviders{
		CPAAPIKeys: keyProvider,
		RequestLogs: logs,
		Status: StatusRouteConfig{CPARequestLogAccessEnabled: true},
	})
	return &ginRouterHarness{handler: router}, token
}

type ginRouterHarness struct {
	handler http.Handler
}

func (h *ginRouterHarness) serve(method, path, token string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, nil)
	request.AddCookie(&http.Cookie{Name: standardSessionCookieName, Value: token})
	if method != http.MethodGet && method != http.MethodHead {
		request.Header.Set(requestIntentHeaderName, requestIntentHeaderValueFetch)
	}
	h.handler.ServeHTTP(response, request)
	return response
}

func TestKeyViewerEventsRequirePerKeyAccess(t *testing.T) {
	usage := &keyViewerUsageEventsStub{usageEventsStub: &usageEventsStub{}}
	router, token := newKeyViewerEventsRouter(t, entities.CPAAPIKey{
		ID: 42, APIKey: "provider-a", DisplayKey: "provider-a",
	}, usage, nil)

	response := router.serve(http.MethodGet, "/api/v1/key-events?range=24h", token)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403: %s", response.Code, response.Body.String())
	}
	if usage.filterCalls != 0 {
		t.Fatalf("disabled key reached usage provider %d times", usage.filterCalls)
	}
}

func TestKeyViewerEventsForceSessionKeyAndHideCredentialIdentity(t *testing.T) {
	usage := &keyViewerUsageEventsStub{usageEventsStub: &usageEventsStub{events: []servicedto.UsageEventRecord{{
		ID:          7,
		Timestamp:   time.Now(),
		APIGroupKey: "provider-a",
		Model:       "gpt-test",
		Provider:    "private-provider",
		Source:      "private-source",
		AuthIndex:   "auth-secret-7",
		AuthType:    "oauth",
		TotalTokens: 12,
	}}}}
	router, token := newKeyViewerEventsRouter(t, entities.CPAAPIKey{
		ID: 42, APIKey: "provider-a", DisplayKey: "sk-*********aaaaaa", KeyAlias: "Viewer",
		ViewerEventsEnabled: true,
	}, usage, nil)

	response := router.serve(http.MethodGet, "/api/v1/key-events?range=24h&api_key_id=99&source=other&auth_type=2", token)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200: %s", response.Code, response.Body.String())
	}
	if usage.lastFilter.APIKeyID != "42" {
		t.Fatalf("expected session API key id 42, got %+v", usage.lastFilter)
	}
	if usage.lastFilter.Source != "" || usage.lastFilter.AuthIndex != "" || usage.lastFilter.AuthType != "" {
		t.Fatalf("viewer source filters were not cleared: %+v", usage.lastFilter)
	}
	body := response.Body.String()
	for _, secret := range []string{"private-provider", "private-source", "auth-secret-7"} {
		if strings.Contains(body, secret) {
			t.Fatalf("viewer response leaked %q: %s", secret, body)
		}
	}
	if !strings.Contains(body, `"model":"gpt-test"`) || !strings.Contains(body, `"api_key":"Viewer"`) {
		t.Fatalf("viewer response omitted own request details: %s", body)
	}
}

func TestKeyViewerRequestLogsRequirePermissionAndEventOwnership(t *testing.T) {
	logs := &requestLogProviderStub{response: service.RequestLogResponse{
		EventID: 7, RequestID: "req-7", Available: true, Previewable: true,
		Sections: []service.RequestLogSection{{Title: "REQUEST INFO", Content: "owned"}},
	}}

	t.Run("permission disabled", func(t *testing.T) {
		usage := &keyViewerUsageEventsStub{usageEventsStub: &usageEventsStub{}, ownsEvent: true}
		router, token := newKeyViewerEventsRouter(t, entities.CPAAPIKey{
			ID: 42, APIKey: "provider-a", ViewerEventsEnabled: true,
		}, usage, logs)
		response := router.serve(http.MethodGet, "/api/v1/key-events/7/request-log", token)
		if response.Code != http.StatusForbidden {
			t.Fatalf("status=%d, want 403: %s", response.Code, response.Body.String())
		}
		if usage.ownershipCalls != 0 {
			t.Fatalf("disabled request-log access performed ownership lookup")
		}
	})

	t.Run("foreign event hidden", func(t *testing.T) {
		logs.calls = 0
		usage := &keyViewerUsageEventsStub{usageEventsStub: &usageEventsStub{}, ownsEvent: false}
		router, token := newKeyViewerEventsRouter(t, entities.CPAAPIKey{
			ID: 42, APIKey: "provider-a", ViewerEventsEnabled: true, ViewerRequestLogsEnabled: true,
		}, usage, logs)
		response := router.serve(http.MethodGet, "/api/v1/key-events/7/request-log", token)
		if response.Code != http.StatusNotFound {
			t.Fatalf("status=%d, want 404: %s", response.Code, response.Body.String())
		}
		if usage.ownershipCalls != 1 || usage.ownedEventID != 7 || usage.ownedAPIKeyID != "42" {
			t.Fatalf("unexpected ownership check: calls=%d event=%d key=%q", usage.ownershipCalls, usage.ownedEventID, usage.ownedAPIKeyID)
		}
		if logs.calls != 0 {
			t.Fatalf("foreign event reached request log provider")
		}
	})

	t.Run("owned event allowed", func(t *testing.T) {
		logs.calls = 0
		usage := &keyViewerUsageEventsStub{usageEventsStub: &usageEventsStub{}, ownsEvent: true}
		router, token := newKeyViewerEventsRouter(t, entities.CPAAPIKey{
			ID: 42, APIKey: "provider-a", ViewerEventsEnabled: true, ViewerRequestLogsEnabled: true,
		}, usage, logs)
		response := router.serve(http.MethodGet, "/api/v1/key-events/7/request-log", token)
		if response.Code != http.StatusOK {
			t.Fatalf("status=%d, want 200: %s", response.Code, response.Body.String())
		}
		if logs.calls != 1 || logs.eventID != 7 {
			t.Fatalf("owned event did not reach request log provider: calls=%d event=%d", logs.calls, logs.eventID)
		}
	})
}
