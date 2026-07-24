/**
 * Mocked appointment scheduling widget.
 *
 * BACKEND WIRING NEEDED:
 * This generates a plausible-looking set of available dates/slots on the
 * client, with no real calendar behind it. To go live, replace
 * `generateAvailableDates()` and `SLOT_TEMPLATE` with a real call to a
 * scheduling/calendar backend, e.g.:
 *
 *   GET  /api/availability?postcode=DT1+1AA&serviceType=first-visit
 *   -> returns real open slots for the local technician's calendar
 *
 *   POST /api/bookings
 *   -> { customerId, slotId } -> confirms the appointment server-side
 *
 * Candidate real integrations: a scheduling API (e.g. Cal.com, Calendly API,
 * or an in-house job-scheduling system tied to technician rounds/routes).
 */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SLOT_TEMPLATE = [
  { id: 'am', label: '9:00am – 11:00am', tag: 'Morning' },
  { id: 'md', label: '12:00pm – 2:00pm', tag: 'Midday' },
  { id: 'pm', label: '2:00pm – 4:00pm', tag: 'Afternoon' }
];

function generateAvailableDates(startOffsetDays = 2, count = 12) {
  const dates = [];
  let d = new Date();
  d.setDate(d.getDate() + startOffsetDays);
  while (dates.length < count) {
    const isSunday = d.getDay() === 0;
    dates.push({
      date: new Date(d),
      disabled: isSunday // demo rule: no Sunday visits
    });
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/**
 * Builds a date + slot picker inside `root` (a DOM element containing
 * .date-picker and .slot-list children). Calls onChange({date, slot})
 * whenever the selection is complete.
 */
function initBookingWidget(root, onChange) {
  const datePicker = root.querySelector('.date-picker');
  const slotList = root.querySelector('.slot-list');
  const slotHint = root.querySelector('.slot-hint');
  let selectedDate = null;
  let selectedSlot = null;

  const dates = generateAvailableDates();

  datePicker.innerHTML = '';
  dates.forEach((entry, i) => {
    const cell = document.createElement('div');
    cell.className = 'date-cell' + (entry.disabled ? ' disabled' : '');
    cell.innerHTML = `<span class="dow">${DOW[entry.date.getDay()]}</span><span class="dnum">${entry.date.getDate()}</span>`;
    if (!entry.disabled) {
      cell.addEventListener('click', () => {
        datePicker.querySelectorAll('.date-cell').forEach(c => c.classList.remove('selected'));
        cell.classList.add('selected');
        selectedDate = entry.date;
        selectedSlot = null;
        renderSlots();
      });
    }
    datePicker.appendChild(cell);
  });

  function renderSlots() {
    slotList.innerHTML = '';
    if (!selectedDate) {
      if (slotHint) slotHint.textContent = 'Pick a date to see available time slots.';
      return;
    }
    if (slotHint) {
      slotHint.textContent = `Available slots for ${selectedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}:`;
    }
    SLOT_TEMPLATE.forEach(slot => {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<span>${slot.label}</span><span class="tag">${slot.tag}</span>`;
      el.addEventListener('click', () => {
        slotList.querySelectorAll('.slot').forEach(s => s.classList.remove('selected'));
        el.classList.add('selected');
        selectedSlot = slot;
        if (onChange) onChange({ date: selectedDate, slot: selectedSlot });
      });
      slotList.appendChild(el);
    });
  }

  renderSlots();
}
