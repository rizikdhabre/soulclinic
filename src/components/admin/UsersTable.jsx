import { useState } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, CalendarDays, Eye } from "lucide-react";
import { UserAvatar } from "./UserAvatar";
import { Button } from "@/components/ui/button";

const USERS_PER_PAGE = 10;

export const UsersTable = ({ users, onViewAppointments }) => {
  const [currentPage, setCurrentPage] = useState(1);

  const totalPages = Math.ceil(users.length / USERS_PER_PAGE);
  const startIndex = (currentPage - 1) * USERS_PER_PAGE;
  const endIndex = startIndex + USERS_PER_PAGE;
  const currentUsers = users.slice(startIndex, endIndex);

  const getLastAppointmentDate = (user) => {
    const pastAppointments = user.appointments.filter(
      (apt) => apt.date < new Date().toISOString().split("T")[0]
    );
    if (!pastAppointments.length) return "No past appointments";
    const lastApt = pastAppointments[0];
    return new Date(lastApt.date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return (
    <div className="bg-card rounded-2xl shadow-card overflow-hidden">
      {/* Desktop */}
      <div className="hidden md:block">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="p-4 text-left text-sm font-semibold text-muted-foreground">Name</th>
              <th className="p-4 text-left text-sm font-semibold text-muted-foreground">Appointments</th>
              <th className="p-4 text-center text-sm font-semibold text-muted-foreground">Total</th>
              <th className="p-4 text-left text-sm font-semibold text-muted-foreground">Last Appointment</th>
            </tr>
          </thead>
          <tbody>
            {currentUsers.map((user, index) => (
              <motion.tr
                key={user.phone}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.03 }}
                className="border-b border-border hover:bg-muted/30"
              >
                <td className="p-4">
                  <div className="flex gap-3 items-center">
                    <UserAvatar firstName={user.firstName} lastName={user.lastName} />
                    <div>
                      <p className="font-medium">{user.firstName} {user.lastName}</p>
                      <p className="text-xs text-muted-foreground">{user.phone}</p>
                    </div>
                  </div>
                </td>
                <td className="p-4">
                  <Button size="sm" variant="outline" onClick={() => onViewAppointments(user)} className="gap-2">
                    <Eye className="w-4 h-4" /> View Appointments
                  </Button>
                </td>
                <td className="p-4 text-center">
                  <span className="inline-flex gap-1.5 items-center px-2.5 py-1 rounded-full bg-muted text-sm">
                    <CalendarDays className="w-3.5 h-3.5" />
                    {user.appointments.length}
                  </span>
                </td>
                <td className="p-4 text-sm text-muted-foreground">
                  {getLastAppointmentDate(user)}
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile */}
<div className="md:hidden divide-y divide-border">
  {currentUsers.map((user) => (
    <div
      key={user.phone}
      className="p-4 flex items-center justify-between gap-4"
    >
      <div className="flex items-center gap-3">
        <UserAvatar
          firstName={user.firstName}
          lastName={user.lastName}
          size="sm"
        />
        <div>
          <p className="font-medium text-sm">
            {user.firstName} {user.lastName}
          </p>
          <p className="text-xs text-muted-foreground">
            {user.phone}
          </p>
          <p className="text-xs text-muted-foreground">
            Appointments: {user.appointments.length}
          </p>
        </div>
      </div>

      <Button
        size="sm"
        variant="outline"
        onClick={() => onViewAppointments(user)}
        className="shrink-0"
      >
        <Eye className="w-4 h-4" />
      </Button>
    </div>
  ))}
</div>

      {/* Pagination */}
      <div className="flex justify-between items-center p-4 border-t border-border bg-muted/30">
        <p className="text-sm text-muted-foreground">
          Showing {startIndex + 1}–{Math.min(endIndex, users.length)} of {users.length}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};
