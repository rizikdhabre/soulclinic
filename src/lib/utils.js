import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function mergeUniqueAppointments(currentItems, nextItems) {
  const seenIds = new Set(
    currentItems.map((item) => item.appointmentId).filter(Boolean),
  );

  const uniqueNextItems = nextItems.filter((item) => {
    if (!item.appointmentId) return true;
    if (seenIds.has(item.appointmentId)) return false;

    seenIds.add(item.appointmentId);
    return true;
  });

  return [...currentItems, ...uniqueNextItems];
}
