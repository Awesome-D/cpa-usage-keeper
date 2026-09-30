import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  createKeyUsageEventRequestLogDownloadURL,
  fetchKeyUsageEventRequestLog,
  fetchKeyUsageEvents,
  isUsageRangeBoundsConflict,
} from '@/lib/api';
import type {
  AuthSessionAPIKeySummary,
  UsageCustomRange,
  UsageEvent,
  UsageEventRequestLogResponse,
  UsageTimeRange,
} from '@/lib/types';
import {
  REQUEST_EVENT_COLUMN_IDS,
  RequestEventsDetailsCard,
  type RequestEventColumnId,
} from '@/components/usage/RequestEventsDetailsCard';
import { TimeRangeControl } from '@/components/usage';
import { KeyViewerShell } from '@/features/key-viewer/KeyViewerShell';
import type { KeyViewerPath } from '@/features/key-viewer/navigation';
import {
  loadKeyViewerTimeRange,
  persistKeyViewerTimeRange,
} from '@/features/key-viewer/timeRange';
import {
  clampStoredUsageRangeStateToCurrentBounds,
  resolveUsageRangeRecoveryTimeZone,
  type StoredUsageRangeState,
} from '@/utils/usage/customRange';
import { buildUsageRangeQuery } from '@/utils/usage/rangeQuery';
import styles from '@/features/key-viewer/KeyViewerShell.module.scss';

const ALL_FILTER = '__all__';
const PAGE_SIZE = 100;
const KEY_EVENTS_VISIBLE_COLUMNS: RequestEventColumnId[] = REQUEST_EVENT_COLUMN_IDS.filter((columnId) => columnId !== 'source');

export interface KeyEventsPageProps {
  apiKey?: AuthSessionAPIKeySummary;
  onNavigate: (path: KeyViewerPath) => void;
  onAuthRequired?: () => void;
}

export function KeyEventsPage({ apiKey, onNavigate, onAuthRequired }: KeyEventsPageProps) {
  const { t } = useTranslation();
  const [timeRangeState, setTimeRangeState] = useState<StoredUsageRangeState>(loadKeyViewerTimeRange);
  const { range: timeRange, customRange } = timeRangeState;
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [manualRefreshLoading, setManualRefreshLoading] = useState(false);
  const [error, setError] = useState('');
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelFilter, setModelFilter] = useState(ALL_FILTER);
  const [resultFilter, setResultFilter] = useState(ALL_FILTER);
  const [requestLogResponse, setRequestLogResponse] = useState<UsageEventRequestLogResponse | null>(null);
  const [requestLogError, setRequestLogError] = useState('');
  const [requestLogLoadingEventId, setRequestLogLoadingEventId] = useState<string | null>(null);
  const [requestLogDownloading, setRequestLogDownloading] = useState(false);
  const requestControllerRef = useRef<AbortController | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const requestLogControllerRef = useRef<AbortController | null>(null);

  const usageRangeQuery = useMemo(() => buildUsageRangeQuery({
    range: timeRange,
    customUnit: customRange?.unit,
    customStart: customRange?.start,
    customEnd: customRange?.end,
  }), [customRange?.end, customRange?.start, customRange?.unit, timeRange]);
  const requestLogAccessEnabled = apiKey?.viewer_request_logs_enabled === true;

  const rememberModels = useCallback((nextEvents: UsageEvent[]) => {
    setModelOptions((current) => {
      const models = new Set(current);
      for (const event of nextEvents) {
        const model = String(event.model ?? '').trim();
        if (model) models.add(model);
      }
      return [...models].sort((left, right) => left.localeCompare(right));
    });
  }, []);

  const recoverRangeBoundsConflict = useCallback((nextError: unknown) => {
    if (!isUsageRangeBoundsConflict(nextError)) return false;
    const timeZone = resolveUsageRangeRecoveryTimeZone(timeRangeState, timeRangeState.timeZone)?.trim();
    if (!timeZone) return false;
    const nextState = clampStoredUsageRangeStateToCurrentBounds(timeRangeState, {
      nowMs: Date.now(),
      timeZone,
    });
    if (nextState === timeRangeState) return false;
    setTimeRangeState(nextState);
    return true;
  }, [timeRangeState]);

  const loadEvents = useCallback(async () => {
    if (!usageRangeQuery.valid || apiKey?.viewer_events_enabled !== true) return;
    requestControllerRef.current?.abort();
    loadMoreControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    setError('');
    setNextCursor(null);
    try {
      const response = await fetchKeyUsageEvents(usageRangeQuery, controller.signal, {
        pageSize: PAGE_SIZE,
        cursorMode: true,
        model: modelFilter === ALL_FILTER ? undefined : modelFilter,
        result: resultFilter === ALL_FILTER ? undefined : resultFilter,
      });
      if (requestControllerRef.current !== controller) return;
      const nextEvents = response.events ?? [];
      setEvents(nextEvents);
      setTotalCount(response.total_count ?? nextEvents.length);
      setNextCursor(response.next_cursor?.trim() || null);
      rememberModels(nextEvents);
    } catch (nextError) {
      if (controller.signal.aborted) return;
      if (recoverRangeBoundsConflict(nextError)) return;
      if (nextError instanceof ApiError && nextError.status === 401) {
        onAuthRequired?.();
        return;
      }
      if (nextError instanceof ApiError && nextError.status === 403) {
        onNavigate('/key-overview');
        return;
      }
      setEvents([]);
      setTotalCount(0);
      setNextCursor(null);
      setError(nextError instanceof Error ? nextError.message : t('key_events.load_failed'));
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [apiKey?.viewer_events_enabled, modelFilter, onAuthRequired, onNavigate, recoverRangeBoundsConflict, rememberModels, resultFilter, t, usageRangeQuery]);

  const loadMore = useCallback(async () => {
    if (!usageRangeQuery.valid || !nextCursor || loadingMore) return;
    loadMoreControllerRef.current?.abort();
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);
    try {
      const response = await fetchKeyUsageEvents(usageRangeQuery, controller.signal, {
        pageSize: PAGE_SIZE,
        cursorMode: true,
        cursor: nextCursor,
        model: modelFilter === ALL_FILTER ? undefined : modelFilter,
        result: resultFilter === ALL_FILTER ? undefined : resultFilter,
      });
      if (loadMoreControllerRef.current !== controller) return;
      const nextEvents = response.events ?? [];
      setEvents((current) => [...current, ...nextEvents]);
      setTotalCount(response.total_count ?? totalCount);
      setNextCursor(response.next_cursor?.trim() || null);
      rememberModels(nextEvents);
    } catch (nextError) {
      if (controller.signal.aborted) return;
      if (nextError instanceof ApiError && nextError.status === 401) {
        onAuthRequired?.();
        return;
      }
      setError(nextError instanceof Error ? nextError.message : t('key_events.load_failed'));
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        setLoadingMore(false);
      }
    }
  }, [loadingMore, modelFilter, nextCursor, onAuthRequired, rememberModels, resultFilter, t, totalCount, usageRangeQuery]);

  useEffect(() => {
    void loadEvents();
    return () => {
      requestControllerRef.current?.abort();
      loadMoreControllerRef.current?.abort();
    };
  }, [loadEvents]);

  useEffect(() => {
    persistKeyViewerTimeRange(timeRangeState);
  }, [timeRangeState]);

  useEffect(() => () => requestLogControllerRef.current?.abort(), []);

  const handleTimeRangeChange = useCallback((nextRange: UsageTimeRange, nextCustomRange?: UsageCustomRange) => {
    setTimeRangeState((current) => nextRange === 'custom' && nextCustomRange
      ? { range: nextRange, customRange: nextCustomRange, timeZone: current.timeZone }
      : { ...current, range: nextRange });
  }, []);

  const handleManualRefresh = useCallback(async () => {
    if (manualRefreshLoading) return;
    setManualRefreshLoading(true);
    try {
      await loadEvents();
    } finally {
      setManualRefreshLoading(false);
    }
  }, [loadEvents, manualRefreshLoading]);

  const handleRequestLogOpen = useCallback(async (event: UsageEvent) => {
    if (!requestLogAccessEnabled) return;
    const eventID = String(event.id ?? '').trim();
    if (!eventID) {
      setRequestLogError(t('usage_stats.request_events_log_missing_event'));
      return;
    }
    requestLogControllerRef.current?.abort();
    const controller = new AbortController();
    requestLogControllerRef.current = controller;
    setRequestLogLoadingEventId(eventID);
    setRequestLogResponse(null);
    setRequestLogError('');
    try {
      const response = await fetchKeyUsageEventRequestLog(eventID, controller.signal);
      if (requestLogControllerRef.current !== controller) return;
      setRequestLogResponse(response);
    } catch (nextError) {
      if (controller.signal.aborted) return;
      if (nextError instanceof ApiError && nextError.status === 401) {
        onAuthRequired?.();
        return;
      }
      setRequestLogError(
        nextError instanceof ApiError && nextError.status === 404
          ? t('usage_stats.request_events_log_unavailable')
          : t('usage_stats.request_events_log_load_failed'),
      );
    } finally {
      if (requestLogControllerRef.current === controller) {
        requestLogControllerRef.current = null;
        setRequestLogLoadingEventId(null);
      }
    }
  }, [onAuthRequired, requestLogAccessEnabled, t]);

  const handleRequestLogClose = useCallback(() => {
    requestLogControllerRef.current?.abort();
    requestLogControllerRef.current = null;
    setRequestLogLoadingEventId(null);
    setRequestLogResponse(null);
    setRequestLogError('');
    setRequestLogDownloading(false);
  }, []);

  const handleRequestLogDownload = useCallback(async (eventID: string) => {
    if (!requestLogAccessEnabled || requestLogDownloading) return;
    setRequestLogDownloading(true);
    try {
      const downloadURL = await createKeyUsageEventRequestLogDownloadURL(eventID);
      const anchor = document.createElement('a');
      anchor.href = downloadURL;
      anchor.download = '';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (nextError) {
      if (nextError instanceof ApiError && nextError.status === 401) {
        onAuthRequired?.();
        return;
      }
      setRequestLogError(t('notification.download_failed'));
    } finally {
      setRequestLogDownloading(false);
    }
  }, [onAuthRequired, requestLogAccessEnabled, requestLogDownloading, t]);

  const displayError = error || (!apiKey?.viewer_events_enabled ? t('key_events.access_disabled') : '');

  return (
    <KeyViewerShell
      activePage="events"
      apiKey={apiKey}
      loading={loading && events.length === 0}
      filters={[
        <TimeRangeControl
          key="range"
          value={timeRange}
          customRange={customRange}
          timeZone={timeRangeState.timeZone}
          onChange={handleTimeRangeChange}
          ariaLabel={t('usage_stats.range_filter')}
          labelInsideTrigger
        />,
      ]}
      onRefresh={() => void handleManualRefresh()}
      refreshing={manualRefreshLoading}
      refreshDisabled={manualRefreshLoading}
      onNavigate={onNavigate}
      onAuthRequired={onAuthRequired}
    >
      {displayError && <div className={styles.errorBox}>{displayError}</div>}
      <RequestEventsDetailsCard
        events={events}
        loading={loading}
        totalCount={totalCount}
        modelOptions={modelOptions}
        sourceOptions={[]}
        modelFilter={modelFilter}
        sourceFilter={ALL_FILTER}
        resultFilter={resultFilter}
        hasMore={Boolean(nextCursor)}
        loadingMore={loadingMore}
        autoLoadMore
        initialVisibleColumnIds={KEY_EVENTS_VISIBLE_COLUMNS}
        initialColumnOrder={REQUEST_EVENT_COLUMN_IDS}
        onModelFilterChange={setModelFilter}
        onSourceFilterChange={() => undefined}
        onResultFilterChange={setResultFilter}
        onLoadMore={() => void loadMore()}
        requestLogAccessEnabled={requestLogAccessEnabled}
        onRequestLogOpen={handleRequestLogOpen}
        requestLogLoadingEventId={requestLogLoadingEventId}
        requestLogResponse={requestLogResponse}
        requestLogError={requestLogError}
        onRequestLogClose={handleRequestLogClose}
        onRequestLogDownload={handleRequestLogDownload}
        requestLogDownloading={requestLogDownloading}
      />
    </KeyViewerShell>
  );
}
