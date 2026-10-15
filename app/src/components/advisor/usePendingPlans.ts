import { useQuery } from '@tanstack/react-query';
import { fetchPlans } from '@/lib/advisor-api';

export function usePendingPlans() {
  return useQuery({
    queryKey: ['advisorPendingPlans'],
    queryFn: () => fetchPlans('pending_approval').catch(() => []),
    refetchInterval: 60_000,
    staleTime: 20_000,
  });
}
