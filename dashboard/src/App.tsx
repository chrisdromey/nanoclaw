import { Routes, Route } from 'react-router-dom';
import MainLayout from './components/layout/MainLayout';
import Overview from './pages/Overview';
import Hunts from './pages/Hunts';
import HuntDetail from './pages/HuntDetail';
import HuntPricesRedirect from './pages/HuntPricesRedirect';
import HuntActivityRedirect from './pages/HuntActivityRedirect';
import Watched from './pages/Watched';
import OfferDetail from './pages/OfferDetail';
import Searches from './pages/Searches';
import AgentActivity from './pages/AgentActivity';
import AgentEvaluations from './pages/AgentEvaluations';
import AgentLogs from './pages/AgentLogs';
import System from './pages/System';

export default function App() {
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route path="/" element={<Overview />} />
        <Route path="/hunts" element={<Hunts />} />
        <Route path="/hunts/:id" element={<HuntDetail />} />
        <Route path="/hunts/:id/prices" element={<HuntPricesRedirect />} />
        <Route path="/hunts/:id/activity" element={<HuntActivityRedirect />} />
        <Route path="/watched" element={<Watched />} />
        <Route path="/offers/:id" element={<OfferDetail />} />
        <Route path="/searches" element={<Searches />} />
        <Route path="/agent" element={<AgentActivity />} />
        <Route path="/agent/evaluations" element={<AgentEvaluations />} />
        <Route path="/agent/logs" element={<AgentLogs />} />
        <Route path="/system" element={<System />} />
      </Route>
    </Routes>
  );
}
