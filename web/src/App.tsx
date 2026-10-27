import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './lib/session';
import { Layout } from './components/Layout';
import { SessionActionProvider } from './components/SessionActionHost';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { DevicesPage } from './pages/Devices';
import { ActiveSessionsPage } from './pages/ActiveSessions';
import { HistoryPage } from './pages/History';
import { NotificationsPage } from './pages/Notifications';
import { StaffPage } from './pages/Staff';
import { SettingsPage } from './pages/Settings';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <SessionActionProvider>
              <Layout>
                <Routes>
                  <Route path="/" element={<OverviewPage />} />
                  <Route path="/devices" element={<DevicesPage />} />
                  <Route path="/sessions" element={<ActiveSessionsPage />} />
                  <Route path="/history" element={<HistoryPage />} />
                  <Route path="/notifications" element={<NotificationsPage />} />
                  <Route path="/staff" element={<StaffPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Layout>
            </SessionActionProvider>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
