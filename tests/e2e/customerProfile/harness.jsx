import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { UsersTable } from '@/components/admin/UsersTable';
import CustomerProfileClient from '@/components/admin/CustomerProfileClient';
import FeedbackClient from '@/app/feedback/[token]/FeedbackClient';

createRoot(document.getElementById('root')).render(<StrictMode>
  <main className="mx-auto max-w-6xl p-4" dir="rtl">
    {location.pathname === '/users' ? <UsersTable users={[{_id: 'customer-one', firstName: 'ليلى', lastName: 'أحمد', phone: '0500000000', appointments: []}]} onViewAppointments={() => {}} /> : location.pathname.startsWith('/feedback/') ? <FeedbackClient token="private-token" /> : <CustomerProfileClient userId="customer-one" />}
  </main>
</StrictMode>);
