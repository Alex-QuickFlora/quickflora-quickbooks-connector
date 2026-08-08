import React, { useCallback, useEffect, useState } from "react";
import {
  Alert, Button, Card, Col, Empty, InputNumber, Popconfirm, Row, Segmented,
  Select, Space, Spin, Statistic, Switch, Table, Tag, Typography,
  App as AntdApp,
} from "antd";
import {
  CheckCircleOutlined, CloudSyncOutlined, DisconnectOutlined,
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

export const QuickBooksAdmin: React.FC<QuickBooksAdminProps> = ({
  supabaseClient,
  product,
  tenantId,
  functionsBaseUrl,
  publishableKey,
}) => {
  const { message } = AntdApp.useApp();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [schedule, setSchedule] = useState<any | null>(null);
  const [runs, setRuns] = useState<any[]>([]);

  const callApi = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      const res = await fetch(`${functionsBaseUrl}/qbo-api`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: publishableKey,
          Authorization: `Bearer ${publishableKey}`,
        },
        body: JSON.stringify({ action, tenantId, ...extra }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) throw new Error(data?.error ?? `qbo-api ${action} failed`);
      return data;
    },
    [functionsBaseUrl, publishableKey, tenantId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sched, runRows] = await Promise.all([
        supabaseClient.from("qb_sync_schedule").select("*")
          .eq("product", product).eq("tenant_id", tenantId).maybeSingle(),
        supabaseClient.from("qb_sync_run").select("*")
          .eq("product", product).eq("tenant_id", tenantId)
          .order("started_at", { ascending: false }).limit(20),
      ]);
      setSchedule(sched.data ?? null);
      setRuns(runRows.data ?? []);
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
      const row = {
        product,
        tenant_id: tenantId,
        enabled: next?.enabled ?? true,
        frequency: next?.frequency ?? "daily",
        hour_utc: next?.hour_utc ?? 10,
        day_of_week: next?.frequency === "weekly" ? next?.day_of_week ?? 1 : null,
        day_of_month: next?.frequency === "monthly" ? next?.day_of_month ?? 1 : null,
        push_journal: next?.push_journal ?? true,
        push_payments: next?.push_payments ?? false,
        window_days: next?.window_days ?? 60,
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabaseClient
        .from("qb_sync_schedule")
        .upsert(row, { onConflict: "product,tenant_id" });
      if (error) throw error;
      setSchedule(row);
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
        extra={<Button type="primary" size="small" icon={<CloudSyncOutlined />}
          loading={busy} disabled={!status?.connected} onClick={syncNow}>Sync now</Button>}>
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
    </div>
  );
};

export default QuickBooksAdmin;
