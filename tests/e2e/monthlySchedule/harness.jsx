import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import MonthlySchedulePlanner from '@/components/admin/MonthlySchedulePlanner';
import BookForCustomer from '@/components/admin/BookForCustomer';
import DailyCalendar from '@/components/admin/DailyCalendar';

createRoot(document.getElementById('root')).render(<StrictMode>
  <main className="mx-auto max-w-6xl p-4" dir="rtl">
    {location.pathname === '/booking' ? <BookForCustomer /> : location.pathname === '/calendar' ? <><MonthlySchedulePlanner /><DailyCalendar /></> : <MonthlySchedulePlanner />}
  </main>
</StrictMode>);
