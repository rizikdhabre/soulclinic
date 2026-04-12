"use client";
import { Switch } from "@/components/ui/Switch";

const MissedAppointmentsList = ({ missedAppointments, onToggleAttendance }) => {
  if (missedAppointments.length === 0) {
    return (
      <p className="text-center text-muted-foreground">
        لا يوجد مواعيد فائتة
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {missedAppointments.map((item, index) => (
        <div
          key={index}
          className="border rounded-xl p-4 flex justify-between items-center"
        >
          <div>
            <p className="font-medium">{item.fullName}</p>
            <p className="text-sm text-muted-foreground">
              {item.date} - {item.time}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={false}
              onCheckedChange={(v) => onToggleAttendance(item.appointmentId, v)}
            />
            <span className="text-destructive text-sm font-medium">
              لم يحضر
            </span>
          </div>
        </div>
      ))}
    </div>
  );
};

export default MissedAppointmentsList;