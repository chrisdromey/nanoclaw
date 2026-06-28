import { Navigate, useParams } from 'react-router-dom';

export default function HuntActivityRedirect() {
  const { id } = useParams();
  return <Navigate to={`/hunts/${id}?tab=activity`} replace />;
}
