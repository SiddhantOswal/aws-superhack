import { USE_LOCAL_MOCK, MOCK_PATHS } from '../../../src/config/localConfig';
import { readJSON } from '../../../src/utils/localService';

const ATHENA_DB = process.env.ATHENA_DB || '';
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP || '';

if (!ATHENA_DB || !ATHENA_WORKGROUP) {
  // Fail fast during cold start to surface misconfiguration
  // eslint-disable-next-line no-console
  console.warn('ATHENA_DB and ATHENA_WORKGROUP must be set');
}

// Local mock mode: no Athena calls. In cloud mode, bootstrap is disabled in this prototype.

// previewOne removed for local prototype

function getQueries(): Array<{ name: string; sql: string }> {
  const scopeUsage = `
CREATE OR REPLACE VIEW scope_usage_vw AS
SELECT
  t.client_id,
  t.category,
  date_trunc('month', from_iso8601_timestamp(t.ticket_time)) AS month,
  sum(coalesce(t.billable_hours, 0)) AS total_billable_hours
FROM tickets t
GROUP BY t.client_id, t.category, date_trunc('month', from_iso8601_timestamp(t.ticket_time));`;

  const shelfware = `
CREATE OR REPLACE VIEW shelfware_vw AS
WITH usage AS (
  SELECT client_id, app, period, count_distinct(user_id) AS active_logins
  FROM logins
  GROUP BY client_id, app, period
)
SELECT
  l.client_id,
  l.app,
  l.period,
  l.seats AS licensed_seats,
  coalesce(u.active_logins, 0) AS active_logins,
  GREATEST(l.seats - coalesce(u.active_logins, 0), 0) AS reclaimable_seats,
  (GREATEST(l.seats - coalesce(u.active_logins, 0), 0) * coalesce(l.annual_price_per_seat, 0)) AS annual_saving
FROM licenses l
LEFT JOIN usage u ON u.client_id = l.client_id AND u.app = l.app AND u.period = l.period;`;

  const underbilling = `
CREATE OR REPLACE VIEW underbilling_vw AS
WITH time_by_period AS (
  SELECT client_id, period, sum(coalesce(amount, 0)) AS time_value
  FROM time_entries
  GROUP BY client_id, period
), invoices_by_period AS (
  SELECT client_id, period, sum(coalesce(amount, 0)) AS invoiced_value
  FROM invoices
  GROUP BY client_id, period
)
SELECT
  coalesce(t.client_id, i.client_id) AS client_id,
  coalesce(t.period, i.period) AS period,
  coalesce(t.time_value, 0) AS time_value,
  coalesce(i.invoiced_value, 0) AS invoiced_value,
  (coalesce(t.time_value, 0) - coalesce(i.invoiced_value, 0)) AS variance
FROM time_by_period t
FULL OUTER JOIN invoices_by_period i
  ON t.client_id = i.client_id AND t.period = i.period;`;

  return [
    { name: 'scope_usage_vw', sql: scopeUsage },
    { name: 'shelfware_vw', sql: shelfware },
    { name: 'underbilling_vw', sql: underbilling },
  ];
}

export async function main(): Promise<{ status: string }> {
  if (USE_LOCAL_MOCK) {
    // Load local data to simulate availability and provide a simple sanity log
    try {
      const licenses = await readJSON<any[]>(MOCK_PATHS.licenses);
      // eslint-disable-next-line no-console
      console.log(`Local bootstrap: loaded ${Array.isArray(licenses) ? licenses.length : 0} licenses`);
    } catch {
      // eslint-disable-next-line no-console
      console.warn('Local bootstrap: unable to read licenses.json');
    }
    return { status: 'ok-local' };
  }
  // Cloud bootstrap disabled for hackathon prototype
  return { status: 'skipped' };
}

export const handler = main;

