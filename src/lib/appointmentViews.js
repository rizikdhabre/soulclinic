function toTimeList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((time) => typeof time === "string" && time.length > 0);
}

export function toPublicAvailability(day) {
  const appointments = Array.isArray(day?.appointments)
    ? day.appointments
        .filter(
          (appointment) =>
            typeof appointment?.time === "string" &&
            appointment.time.length > 0 &&
            Number.isFinite(appointment.duration) &&
            appointment.duration > 0,
        )
        .map(({ time, duration }) => ({ time, duration }))
    : [];

  return {
    appointments,
    blockedTimes: toTimeList(day?.blockedTimes),
    editedTimes: toTimeList(day?.editedTimes),
  };
}
