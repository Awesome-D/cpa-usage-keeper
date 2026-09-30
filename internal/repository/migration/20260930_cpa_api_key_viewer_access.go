package migration

import (
	"fmt"

	"cpa-usage-keeper/internal/entities"
	"gorm.io/gorm"
)

// addCPAAPIKeyViewerAccessMigration adds opt-in viewer capabilities. Existing keys remain unchanged
// because both columns default to false, preserving the current read-only viewer surface.
func addCPAAPIKeyViewerAccessMigration(tx *gorm.DB) error {
	if tx == nil {
		return fmt.Errorf("database is nil")
	}
	for _, field := range []string{"ViewerEventsEnabled", "ViewerRequestLogsEnabled"} {
		if tx.Migrator().HasColumn(&entities.CPAAPIKey{}, field) {
			continue
		}
		if err := tx.Migrator().AddColumn(&entities.CPAAPIKey{}, field); err != nil {
			return fmt.Errorf("add CPA API key %s: %w", field, err)
		}
	}
	return nil
}
