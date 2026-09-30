import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthSessionAPIKeySummary, UsageEvent } from '@/lib/types';
import { ApiError, fetchKeyUsageEvents } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { KeyViewerShell, type KeyViewerPath } from '@/features/key-viewer';

interface KeyEventsPageProps {
  apiKey?: AuthSessionAPIKeySummary;
  onNavigate: (path: KeyViewerPath) => void;
  onAuthRequired?: () => void;
}

export function KeyEventsPage({ apiKey, onNavigate, onAuthRequired }: KeyEventsPageProps) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('range', '24h');
      params.set('page_size', '100');
      const response = await fetchKeyUsageEvents(params);
      setEvents(response.events ?? []);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthRequired?.();
        return;
      }
      setError(err instanceof Error ? err.message : t('usage_stats.credentials_detail_requests_load_failed'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [onAuthRequired, t]);

  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <KeyViewerShell
      activePage="events"
      apiKey={apiKey}
      loading={loading}
      onRefresh={() => void load(true)}
      refreshing={refreshing}
      onNavigate={onNavigate}
      onAuthRequired={onAuthRequired}
    >
      <Card
        title={t('usage_stats.key_events_title')}
        subtitle={t('usage_stats.key_events_subtitle')}
      >
        {error ? (
          <p>{error}</p>
        ) : events.length === 0 ? (
          <p>{t('usage_stats.key_events_empty')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '10px 8px' }}>{t('usage_stats.request_events_timestamp')}</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px' }}>{t('usage_stats.model_name')}</th>
                  <th style={{ textAlign: 'right', padding: '10px 8px' }}>{t('usage_stats.total_tokens')}</th>
                  <th style={{ textAlign: 'right', padding: '10px 8px' }}>{t('usage_stats.latency')}</th>
                  <th style={{ textAlign: 'left', padding: '10px 8px' }}>{t('usage_stats.result')}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td style={{ padding: '10px 8px' }}>{new Date(event.timestamp).toLocaleString()}</td>
                    <td style={{ padding: '10px 8px' }}>{event.model || '-'}</td>
                    <td style={{ textAlign: 'right', padding: '10px 8px' }}>{event.tokens?.total_tokens?.toLocaleString?.() ?? 0}</td>
                    <td style={{ textAlign: 'right', padding: '10px 8px' }}>{event.latency_ms?.toLocaleString?.() ?? 0} ms</td>
                    <td style={{ padding: '10px 8px' }}>{event.failed ? (event.status_code ?? t('common.error')) : (event.status_code ?? 200)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </KeyViewerShell>
  );
}
