// Visit scheduling.
//
// This is the operational core of the business, not an admin nicety: the whole
// proposition is "scheduled automatically, so it never gets forgotten". If
// nothing tracks who is due and when, that promise is just words on a page.
//
// Deliberately pure functions with dates passed in, so the maths is testable
// without mocking the clock or Netlify Blobs.

/** Scheduled visits per year, by plan. Premium's 2 callouts are on demand and
 *  are NOT scheduled visits, so they don't appear here. */
const VISITS_PER_YEAR = { essential: 1, standard: 2, premium: 2 };

/** Months between scheduled visits, by plan. */
const CADENCE_MONTHS = { essential: 12, standard: 6, premium: 6 };

/**
 * Add whole months to a date, clamping the day so 31 Jan + 1 month is
 * 28/29 Feb rather than rolling into March. JS Date arithmetic silently
 * overflows, which would quietly drift every schedule that started on a 29th,
 * 30th or 31st.
 */
function addMonths(date, months) {
  const d = new Date(date.getTime());
  const targetDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(targetDay, lastDayOfTargetMonth));
  return d;
}

const toISODate = (d) => d.toISOString().slice(0, 10);
const parseDate = (v) => (v instanceof Date ? v : new Date(`${String(v).slice(0, 10)}T00:00:00Z`));

/**
 * When is this customer next due?
 *
 * Based on the last completed visit, or on the start date if they've never
 * had one. An unknown plan falls back to annual rather than throwing —
 * a bad plan value must not remove somebody from the schedule entirely.
 */
function nextDueDate({ plan, startDate, lastVisit }) {
  const months = CADENCE_MONTHS[String(plan).toLowerCase()] || 12;
  const from = lastVisit ? parseDate(lastVisit) : parseDate(startDate);
  // Never visited: the first visit is due at sign-up, not a cadence later.
  return lastVisit ? toISODate(addMonths(from, months)) : toISODate(from);
}

/** Negative = overdue by that many days. */
function daysUntil(iso, today = new Date()) {
  const a = parseDate(iso).getTime();
  const b = parseDate(toISODate(today)).getTime();
  return Math.round((a - b) / 86400000);
}

/**
 * Decorate a customer with scheduling state.
 * `status` drives the admin UI and the weekly digest.
 */
function withSchedule(customer, today = new Date()) {
  const due = customer.nextDue || nextDueDate(customer);
  const days = daysUntil(due, today);
  let status = 'scheduled';
  if (customer.status === 'cancelled') status = 'cancelled';
  else if (days < 0) status = 'overdue';
  else if (days <= 14) status = 'due-soon';
  return { ...customer, nextDue: due, daysUntilDue: days, scheduleStatus: status };
}

/**
 * Everyone needing attention, most overdue first.
 * Cancelled customers are excluded — they should never appear on a work list.
 */
function dueList(customers, today = new Date(), horizonDays = 14) {
  return customers
    .filter(c => c.status !== 'cancelled')
    .map(c => withSchedule(c, today))
    .filter(c => c.daysUntilDue <= horizonDays)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
}

/** Record a completed visit and roll the schedule forward. */
function completeVisit(customer, visitDate = new Date()) {
  const done = toISODate(parseDate(visitDate));
  const history = Array.isArray(customer.visitHistory) ? customer.visitHistory : [];
  const updated = {
    ...customer,
    lastVisit: done,
    visitHistory: [...history, done],
    visitsCompleted: (customer.visitsCompleted || 0) + 1
  };
  updated.nextDue = nextDueDate(updated);
  return updated;
}

module.exports = {
  VISITS_PER_YEAR, CADENCE_MONTHS,
  addMonths, toISODate, nextDueDate, daysUntil,
  withSchedule, dueList, completeVisit
};
