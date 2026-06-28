import { Navigate, useParams } from 'react-router-dom';

export default function HuntPricesRedirect() {
  const { id } = useParams();
  return <Navigate to={`/hunts/${id}?tab=market`} replace />;
}
