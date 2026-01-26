"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { UsersTable } from "@/components/admin/UsersTable";
import { AppointmentsModal } from "@/components/admin/AppointmentsModal";
import { AttendanceChart } from "@/components/admin/AttendanceChart";
import { Input } from "@/components/ui/input";

export default function UsersAdminPage() {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState("");
  const [selectedUser, setSelectedUser] = useState(null);
  const [loading, setLoading] = useState(true);

  /* ---------------- FETCH USERS ---------------- */

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const res = await axios.get("/api/admin/users");
        setUsers(res.data);
      } catch (err) {
        console.error("Failed to load users", err);
      } finally {
        setLoading(false);
      }
    };

    fetchUsers();
  }, []);

  /* ---------------- DERIVED DATA ---------------- */

  const filteredUsers = users.filter((u) => {
    const fullName = `${u.firstName} ${u.lastName}`.toLowerCase();
    return fullName.includes(search.toLowerCase());
  });

  const allAppointments = users.flatMap((u) => u.appointments || []);
  const attendedCount = allAppointments.filter((a) => a.attended).length;
  const totalCount = allAppointments.length;
  const attendanceRate =
    totalCount === 0 ? 0 : Math.round((attendedCount / totalCount) * 100);

  /* ---------------- HANDLERS ---------------- */

  const handleViewAppointments = (user) => {
    setSelectedUser(user);
  };

  const handleToggleAttendance = (appointmentId, attended) => {
    setUsers((prev) =>
      prev.map((u) => ({
        ...u,
        appointments: u.appointments.map((a) =>
          String(a._id) === String(appointmentId) ? { ...a, attended } : a,
        ),
      })),
    );

    setSelectedUser((prev) =>
      prev
        ? {
            ...prev,
            appointments: prev.appointments.map((a) =>
              String(a._id) === String(appointmentId) ? { ...a, attended } : a,
            ),
          }
        : prev,
    );
  };
  const handleCancelAppointment = async (appointmentId) => {
    const appointment = selectedUser?.appointments?.find(
      (a) => String(a._id) === String(appointmentId),
    );
    if (!appointment) return;

    //  Optimistic UI: remove immediately from users + selectedUser
    setUsers((prev) =>
      prev.map((u) => ({
        ...u,
        appointments: (u.appointments || []).filter(
          (a) => String(a._id) !== String(appointmentId),
        ),
      })),
    );

    setSelectedUser((prev) =>
      prev
        ? {
            ...prev,
            appointments: (prev.appointments || []).filter(
              (a) => String(a._id) !== String(appointmentId),
            ),
          }
        : prev,
    );

    try {
      await axios.delete("/api/appointments", {
        data: {
          phone: selectedUser.phone,
          date: appointment.date,
          time: appointment.time,
        },
      });
    } catch (error) {
      console.error("Failed to cancel appointment", error);
      // (optional) if you want: refetch user appointments here
    }
  };

  const handleUpdateAdminNotes = (phone, adminNotes) => {
    setUsers((prev) =>
      prev.map((u) => (u.phone === phone ? { ...u, adminNotes } : u)),
    );

    setSelectedUser((prev) =>
      prev && prev.phone === phone ? { ...prev, adminNotes } : prev,
    );
  };

  /* ---------------- UI ---------------- */

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading users…</div>;
  }

  return (
    <div className="min-h-screen p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold mt-20">إدارة المستخدمين</h1>
        <p className="text-sm text-muted-foreground">
          إدارة العملاء والمواعيد والحضور
        </p>
      </div>

      {/* Top Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Search */}
        <div className="lg:col-span-2 bg-card rounded-2xl p-6 shadow-card">
          <label className="block text-sm font-medium mb-2 text-muted-foreground">
           بحث عن المستخدمين
          </label>
          <Input
            placeholder="ابحث بالاسم الأول أو اسم العائلة أو الاسم الكامل…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Stats */}
        <AttendanceChart
          rate={attendanceRate}
          attended={attendedCount}
          total={totalCount}
        />
      </div>

      {/* Users Table */}
      {filteredUsers.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          لا يوجد مستخدمون
        </div>
      ) : (
        <UsersTable
          users={filteredUsers}
          onViewAppointments={handleViewAppointments}
        />
      )}

      {/* Appointments Modal */}
      {selectedUser && (
        <AppointmentsModal
          user={selectedUser}
          isOpen={!!selectedUser}
          onClose={() => setSelectedUser(null)}
          onToggleAttendance={handleToggleAttendance}
          onCancelAppointment={handleCancelAppointment}
          onUpdateAdminNotes={handleUpdateAdminNotes}
        />
      )}
    </div>
  );
}
