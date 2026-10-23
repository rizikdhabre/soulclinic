import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import UnsubscribeClient from '@/app/reminders/unsubscribe/[token]/UnsubscribeClient';
import ReturnReminderPreference from '@/components/admin/ReturnReminderPreference';
import CustomerProfileClient from '@/components/admin/CustomerProfileClient';

function ProfileSwitch() {
  const [userId, setUserId] = useState('000000000000000000000011');
  return <>
    <button type="button" onClick={() => setUserId('000000000000000000000022')}>عرض الزبون التالي</button>
    <CustomerProfileClient userId={userId} />
  </>;
}

createRoot(document.getElementById('root')).render(<StrictMode>
  <div className="mx-auto max-w-5xl p-4" dir="rtl">
    {location.pathname === '/profile-switch' ? <ProfileSwitch /> : location.pathname === '/admin' ? <ReturnReminderPreference userId="000000000000000000000011" /> : <UnsubscribeClient token="private-token" />}
  </div>
</StrictMode>);
