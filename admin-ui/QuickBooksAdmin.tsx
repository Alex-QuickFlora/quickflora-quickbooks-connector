import React, { useCallback, useEffect, useState } from "react";
import {
  Alert, Button, Card, Col, Empty, Input, InputNumber, Popconfirm, Row, Segmented,
  Select, Space, Spin, Statistic, Switch, Table, Tag, Typography,
  App as AntdApp,
} from "antd";
import {
  CheckCircleOutlined, CloudSyncOutlined, DisconnectOutlined, EyeOutlined,
  LinkOutlined, ReloadOutlined, SyncOutlined,
} from "@ant-design/icons";

const { Title, Text } = Typography;

/**
 * QuickBooksAdmin — the reusable QBO connector admin panel (#1207).
 *
 * ONE self-contained component; each Sunflower product embeds it with its
 * own client and identity:
 *
 *   <QuickBooksAdmin
 *     supabaseClient={supabase}            // the product's supabase-js client
 *     product="florachain"                 // registry key
 *     tenantId={tenant.id}                 // whose connection this manages
 *     functionsBaseUrl="https://<ref>.supabase.co/functions/v1"
 *     publishableKey="sb_publishable_…"    // apikey header for the functions
 *   />
 *
 * Nothing is hardcoded: no URLs, no tenants, no product names. Theme it from
 * the host app's antd <ConfigProvider> — this component introduces no colors
 * of its own.
 *
 * Security model: the component never reads qb_connection (refresh tokens
 * are service-role only); status comes from the qbo-api function. Schedule
 * and run history read/write via the product's client — the product's RLS
 * decides who may see them.
 */

export interface QuickBooksAdminProps {
  supabaseClient: any;
  product: string;
  tenantId: string;
  functionsBaseUrl: string;
  publishableKey: string;
  /**
   * Connector API key, sent as x-connector-key on write actions (Sync Now,
   * Retry failed, Preview is a read-only dryRun but is served by push
   * actions, so it needs the key too, as does save-schedule). RED 1 control:
   * the functions reject writes without it. At go-live this is replaced by
   * the user's Auth0 JWT.
   */
  connectorKey?: string;
}

interface StatusInfo {
  connected: boolean;
  realm?: string;
  sandbox?: boolean;
  company?: string | null;
  lastSyncAt?: string | null;
  lastSyncNote?: string | null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** #1223: mirror of core/qbo-client.ts's qboDeepLink — duplicated here so
 *  this component keeps zero imports beyond React + antd. */
const QBO_ENTITY_PATHS: Record<string, string> = {
  journalentry: "journal", invoice: "invoice", bill: "bill",
  creditmemo: "creditmemo", payment: "customerpayment", deposit: "deposit",
};
const qboLink = (sandbox: boolean, entityType: string, qboId: string) =>
  `${sandbox ? "https://app.sandbox.qbo.intuit.com" : "https://app.qbo.intuit.com"}/app/${QBO_ENTITY_PATHS[entityType] ?? "journal"}?txnId=${encodeURIComponent(qboId)}`;

export const QuickBooksAdmin: React.FC<QuickBooksAdminProps> = ({
  supabaseClient,
  product,
  tenantId,
  functionsBaseUrl,
  publishableKey,
  connectorKey,
}) => {
  const { message } = AntdApp.useApp();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [schedule, setSchedule] = useState<any | null>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [results, setResults] = useState<any[]>([]);
  const [preview, setPreview] = useState<any[] | null>(null);
  const [previewRange, setPreviewRange] = useState<[string, string]>(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 86_400_000);
    return [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
  });

  const callApi = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      const res = await fetch(`${functionsBaseUrl}/qbo-api`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: publishableKey,
          Authorization: `Bearer ${publishableKey}`,
          ...(connectorKey ? { "x-connector-key": connectorKey } : {}),
        },
        body: JSON.stringify({ action, tenantId, ...extra }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) throw new Error(data?.error ?? `qbo-api ${action} failed`);
      return data;
    },
    [functionsBaseUrl, publishableKey, tenantId, connectorKey],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sched, runRows, resultRows] = await Promise.all([
        supabaseClient.from("qb_sync_schedule").select("*")
          .eq("product", product).eq("tenant_id", tenantId).maybeSingle(),
        supabaseClient.from("qb_sync_run").select("*")
          .eq("product", product).eq("tenant_id", tenantId)
          .order("started_at", { ascending: false }).limit(20),
        supabaseClient.from("qb_push_result").select("*")
          .eq("product", product).eq("tenant_id", tenantId)
          .order("created_at", { ascending: false }).limit(100),
      ]);
      setSchedule(sched.data ?? null);
      setRuns(runRows.data ?? []);
      setResults(resultRows.data ?? []);
      try {
        setStatus(await callApi("status"));
      } catch {
        setStatus({ connected: false }); // not connected yet, or token dead
      }
    } catch (e: any) {
      message.error(e.message ?? "Could not load the QuickBooks settings.");
    } finally {
      setLoading(false);
    }
  }, [supabaseClient, product, tenantId, callApi, message]);
  useEffect(() => { load(); }, [load]);

  const connect = () => {
    window.location.href =
      `${functionsBaseUrl}/qbo-auth-callback?action=start&product=${encodeURIComponent(product)}&tenant=${encodeURIComponent(tenantId)}`;
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await callApi("disconnect");
      message.success("Disconnected from QuickBooks.");
      await load();
    } catch (e: any) {
      message.error(e.message ?? "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  };

  const saveSchedule = async (patch: Record<string, unknown>) => {
    const next = { ...schedule, ...patch };
    setBusy(true);
    try {
      // RED 2: schedule writes go through the keyed qbo-api action — the
      // client has no direct write policy on qb_sync_schedule anymore.
      const row = {
        enabled: next?.enabled ?? true,
        frequency: next?.frequency ?? "daily",
        hour_utc: next?.hour_utc ?? 10,
        day_of_week: next?.frequency === "weekly" ? next?.day_of_week ?? 1 : null,
        day_of_month: next?.frequency === "monthly" ? next?.day_of_month ?? 1 : null,
        push_journal: next?.push_journal ?? true,
        push_payments: next?.push_payments ?? false,
        window_days: next?.window_days ?? 60,
      };
      await callApi("save-schedule", { schedule: row });
      setSchedule({ product, tenant_id: tenantId, ...row });
      message.success("Schedule saved.");
    } catch (e: any) {
      message.error(e.message ?? "Could not save the schedule.");
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const r = await callApi("run");
      message.success(`Sync complete — ${r.succeeded ?? 0} ok, ${r.failed ?? 0} failed.`);
      await load();
    } catch (e: any) {
      message.error(e.message ?? "Sync failed.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  /** #1221: dry-run the journal + payment pushes over the chosen range and
   *  show what WOULD happen, record by record. Nothing is written. */
  const runPreview = async () => {
    setBusy(true);
    setPreview(null);
    try {
      const [from, to] = previewRange;
      const reports = await Promise.all(
        ["push-journal", "push-payments"].map((action) => callApi(action, { from, to, dryRun: true })),
      );
      const rows: any[] = [];
      for (const r of reports) {
        for (const w of r.wouldCreate ?? []) rows.push({ key: `c-${r.entityType}-${w.sourceId}`, verdict: "create", entity: r.entityType, ...w });
        for (const w of r.wouldSkip ?? []) rows.push({ key: `s-${r.entityType}-${w.sourceId}`, verdict: "skip", entity: r.entityType, ...w });
        for (const w of r.wouldFail ?? []) rows.push({ key: `f-${r.entityType}-${w.sourceId}`, verdict: "fail", entity: r.entityType, ...w });
      }
      setPreview(rows);
      if (!rows.length) message.info("Nothing in that range.");
    } catch (e: any) {
      message.error(e.message ?? "Preview failed.");
    } finally {
      setBusy(false);
    }
  };

  /** #1222: re-push only records whose latest result row is failed. */
  const retryFailed = async () => {
    setBusy(true);
    try {
      const [from, to] = previewRange;
      const r = await callApi("retry-failed", { from, to });
      message.success(`Retried ${r.retried ?? 0} failed record(s).`);
      await load();
    } catch (e: any) {
      message.error(e.message ?? "Retry failed.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 48, textAlign: "center" }}><Spin size="large" /></div>;
  }

  return (
    <div>
      <Row justify="space-between" align="middle">
        <Col>
          <Title level={4} style={{ marginBottom: 0 }}>QuickBooks Online</Title>
          <Text type="secondary">Live connector — journal entries and payments, on a schedule.</Text>
        </Col>
        <Col>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load}>Refresh</Button>
            {status?.connected ? (
              <Popconfirm title="Disconnect this company from QuickBooks?" onConfirm={disconnect}
                okText="Disconnect" okButtonProps={{ danger: true }}>
                <Button danger icon={<DisconnectOutlined />} loading={busy}>Disconnect</Button>
              </Popconfirm>
            ) : (
              <Button type="primary" icon={<LinkOutlined />} onClick={connect}>
                Connect to QuickBooks
              </Button>
            )}
          </Space>
        </Col>
      </Row>

      {status?.connected ? (
        <Alert style={{ marginTop: 16 }} type="success" showIcon
          icon={<CheckCircleOutlined />}
          message={<Space wrap>
            <Text strong>{status.company ?? "Connected"}</Text>
            <Text type="secondary">realm {status.realm}</Text>
            {status.sandbox && <Tag color="orange">SANDBOX</Tag>}
            {status.lastSyncAt && (
              <Text type="secondary">
                last sync {new Date(status.lastSyncAt).toLocaleString()}
                {status.lastSyncNote ? ` — ${status.lastSyncNote}` : ""}
              </Text>
            )}
          </Space>} />
      ) : (
        <Alert style={{ marginTop: 16 }} type="info" showIcon
          message="Not connected"
          description="Connect a QuickBooks Online company to start syncing. Use a sandbox company while testing." />
      )}

      <Card size="small" title="Sync schedule" style={{ marginTop: 16 }}
        extra={<Space wrap>
          <Input type="date" size="small" style={{ width: 150 }} value={previewRange[0]}
            onChange={(e) => setPreviewRange(([_, to]) => [e.target.value, to])} />
          <Input type="date" size="small" style={{ width: 150 }} value={previewRange[1]}
            onChange={(e) => setPreviewRange(([from]) => [from, e.target.value])} />
          <Button size="small" icon={<EyeOutlined />} loading={busy}
            disabled={!status?.connected} onClick={runPreview}>Preview</Button>
          <Button type="primary" size="small" icon={<CloudSyncOutlined />}
            loading={busy} disabled={!status?.connected} onClick={syncNow}>Sync now</Button>
        </Space>}>
        <Space wrap size={16}>
          <Switch checked={schedule?.enabled ?? false}
            onChange={(v) => saveSchedule({ enabled: v })} checkedChildren="On" unCheckedChildren="Off" />
          <Segmented value={schedule?.frequency ?? "daily"}
            onChange={(v) => saveSchedule({ frequency: String(v) })}
            options={["daily", "weekly", "monthly"]} />
          {schedule?.frequency === "weekly" && (
            <Select style={{ width: 130 }} value={schedule?.day_of_week ?? 1}
              onChange={(v) => saveSchedule({ day_of_week: v })}
              options={DAY_NAMES.map((d, i) => ({ value: i, label: d }))} />
          )}
          {schedule?.frequency === "monthly" && (
            <InputNumber min={1} max={28} value={schedule?.day_of_month ?? 1}
              onChange={(v) => saveSchedule({ day_of_month: v ?? 1 })} addonBefore="Day" />
          )}
          <InputNumber min={0} max={23} value={schedule?.hour_utc ?? 10}
            onChange={(v) => saveSchedule({ hour_utc: v ?? 10 })} addonBefore="Hour (UTC)" />
          <Tag.CheckableTag checked={schedule?.push_journal ?? true}
            onChange={(v) => saveSchedule({ push_journal: v })}>Journal entries</Tag.CheckableTag>
          <Tag.CheckableTag checked={schedule?.push_payments ?? false}
            onChange={(v) => saveSchedule({ push_payments: v })}>Payments</Tag.CheckableTag>
        </Space>
        {schedule?.next_run_at && schedule?.enabled && (
          <div style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Next run {new Date(schedule.next_run_at).toLocaleString()}
            </Text>
          </div>
        )}
      </Card>

      {preview && (
        <Card size="small" title="Preview — nothing written yet" style={{ marginTop: 16 }}>
          <Table size="small" rowKey="key" dataSource={preview} pagination={{ pageSize: 20 }}
            locale={{ emptyText: <Empty description="Nothing in that range." /> }}
            columns={[
              { title: "", dataIndex: "verdict", width: 90,
                render: (v: string) => (
                  <Tag color={v === "create" ? "green" : v === "fail" ? "red" : "default"}>
                    {v === "create" ? "CREATE" : v === "fail" ? "FAIL" : "SKIP"}</Tag>
                ),
                filters: [
                  { text: "Create", value: "create" },
                  { text: "Skip", value: "skip" },
                  { text: "Fail", value: "fail" },
                ],
                onFilter: (v: any, r: any) => r.verdict === v },
              { title: "Entity", dataIndex: "entity", width: 110, render: (v: string) => <Tag>{v}</Tag> },
              { title: "Ref", dataIndex: "ref", width: 110, render: (v: string) => <Text strong>{v}</Text> },
              { title: "Date", dataIndex: "date", width: 110, render: (v: string | undefined) => v ?? "—" },
              { title: "Lines / reason", ellipsis: true,
                render: (_: any, r: any) => r.error
                  ? <Text type="danger" style={{ fontSize: 12 }}>{r.error}</Text>
                  : r.reason
                  ? <Text type="secondary" style={{ fontSize: 12 }}>{r.reason}</Text>
                  : <Text type="secondary" style={{ fontSize: 12 }}>
                      {(r.lines ?? []).map((l: any) =>
                        l.qbName ? `${l.qbName} ${l.debit ? `DR ${l.debit}` : l.credit ? `CR ${l.credit}` : l.amount ?? ""}` : (l.memo ?? "")
                      ).join(" · ")}
                    </Text> },
            ]} />
        </Card>
      )}

      <Card size="small" title="Sync history" style={{ marginTop: 16 }}>
        <Table size="small" rowKey="id" dataSource={runs} pagination={{ pageSize: 10 }}
          locale={{ emptyText: <Empty description="No syncs yet." /> }}
          columns={[
            { title: "Started", dataIndex: "started_at", width: 180,
              render: (v: string) => new Date(v).toLocaleString() },
            { title: "Trigger", dataIndex: "trigger_type", width: 90,
              render: (v: string) => <Tag>{v}</Tag> },
            { title: "Status", dataIndex: "status", width: 100,
              render: (v: string) => (
                <Tag color={v === "ok" ? "green" : v === "error" ? "red" : "blue"}
                  icon={v === "running" ? <SyncOutlined spin /> : undefined}>{v}</Tag>
              ) },
            { title: "Entries", dataIndex: "entries_pushed", width: 80, align: "right" },
            { title: "Payments", dataIndex: "payments_pushed", width: 90, align: "right" },
            { title: "Error", dataIndex: "error", ellipsis: true,
              render: (v: string | null) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : "—" },
          ]} />
      </Card>

      {/* #1222/#1223: latest outcome per record, with deep links into QBO
          and a retry that re-pushes only the failed ones. */}
      <Card size="small" title="Sync results (per record)" style={{ marginTop: 16 }}
        extra={<Button size="small" danger icon={<ReloadOutlined />} loading={busy}
          disabled={!results.some((r) => r.status === "failed")}
          onClick={retryFailed}>Retry failed</Button>}>
        <Table size="small" rowKey="id" dataSource={results} pagination={{ pageSize: 10 }}
          locale={{ emptyText: <Empty description="Nothing pushed yet." /> }}
          columns={[
            { title: "Entity", dataIndex: "entity_type", width: 110, render: (v: string) => <Tag>{v}</Tag> },
            { title: "Ref", dataIndex: "ref", width: 110,
              render: (v: string | null) => <Text strong>{v ?? "—"}</Text> },
            { title: "Status", dataIndex: "status", width: 90,
              render: (v: string, r: any) => (
                <Space size={4}>
                  <Tag color={v === "ok" ? "green" : v === "failed" ? "red" : "default"}>{v}</Tag>
                  {r.warning && <Tag color="orange">warn</Tag>}
                </Space>
              ),
              filters: [
                { text: "ok", value: "ok" },
                { text: "failed", value: "failed" },
                { text: "skipped", value: "skipped" },
              ],
              onFilter: (v: any, r: any) => r.status === v },
            { title: "QBO", dataIndex: "qbo_id", width: 90,
              render: (v: string | null, r: any) => v ? (
                <a href={qboLink(status?.sandbox ?? true, r.entity_type, v)}
                  target="_blank" rel="noreferrer">#{v}</a>
              ) : "—" },
            { title: "Error / warning", ellipsis: true,
              render: (_: any, r: any) => r.error
                ? <Text type="danger" style={{ fontSize: 12 }}>{r.error}</Text>
                : r.warning
                ? <Text type="warning" style={{ fontSize: 12 }}>{r.warning}</Text>
                : "—" },
            { title: "When", dataIndex: "created_at", width: 170,
              render: (v: string) => new Date(v).toLocaleString() },
          ]} />
      </Card>
    </div>
  );
};

export default QuickBooksAdmin;
