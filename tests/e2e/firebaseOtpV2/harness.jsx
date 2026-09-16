import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import LoginPage from '@/components/ui/LoginPage';
import { AppointmentForm } from '@/components/ui/AppointmentForm';
import AppointmentsClient from '@/app/appointments/AppointmentsClient';

const root = createRoot(document.getElementById('root'));
window.__otpTest.unmount = () => root.unmount();
const booking = <AppointmentForm
  selectedDate={new Date('2030-01-15T12:00:00Z')}
  selectedTime="10:30"
  onSubmit={async payload => {
    window.__otpTest.submissions.push(payload);
    return !window.__otpTest.scenario.bookingFailure;
  }}
/>;
const both = location.pathname === '/both';
root.render(<StrictMode>
  {location.pathname === '/appointments' ? <section data-testid="booking"><AppointmentsClient /></section> :
  <main className="w-full px-4 py-8" dir="rtl">
    <div className="w-full max-w-md min-w-0 mx-auto">
      {(both || location.pathname === '/login') && <section data-testid="login"><LoginPage /></section>}
      {(both || location.pathname === '/booking') && <section data-testid="booking">{booking}</section>}
    </div>
  </main>
  }
</StrictMode>);
