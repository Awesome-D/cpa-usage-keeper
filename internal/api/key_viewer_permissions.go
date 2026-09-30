package api

import (
	"net/http"
	"sort"
	"strings"

	"cpa-usage-keeper/internal/entities"

	"github.com/gin-gonic/gin"
)

const (
	keyViewerPermissionRequestEvents = "request_events"
)

var supportedKeyViewerPermissions = map[string]struct{}{
	keyViewerPermissionRequestEvents: {},
}

func parseKeyViewerPermissions(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return []string{}
	}
	seen := make(map[string]struct{})
	result := make([]string, 0)
	for _, part := range strings.Split(raw, ",") {
		permission := strings.TrimSpace(part)
		if _, ok := supportedKeyViewerPermissions[permission]; !ok {
			continue
		}
		if _, ok := seen[permission]; ok {
			continue
		}
		seen[permission] = struct{}{}
		result = append(result, permission)
	}
	sort.Strings(result)
	return result
}

func normalizeKeyViewerPermissions(values []string) (string, bool) {
	seen := make(map[string]struct{})
	result := make([]string, 0, len(values))
	for _, value := range values {
		permission := strings.TrimSpace(value)
		if _, ok := supportedKeyViewerPermissions[permission]; !ok {
			return "", false
		}
		if _, ok := seen[permission]; ok {
			continue
		}
		seen[permission] = struct{}{}
		result = append(result, permission)
	}
	sort.Strings(result)
	return strings.Join(result, ","), true
}

func keyHasViewerPermission(key entities.CPAAPIKey, permission string) bool {
	for _, current := range parseKeyViewerPermissions(key.ViewerPermissions) {
		if current == permission {
			return true
		}
	}
	return false
}

func requireKeyViewerPermission(permission string) gin.HandlerFunc {
	return func(c *gin.Context) {
		_, key, ok := activeAPIKeyViewerContext(c)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
			return
		}
		if !keyHasViewerPermission(key, permission) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "viewer permission required"})
			return
		}
		c.Next()
	}
}
