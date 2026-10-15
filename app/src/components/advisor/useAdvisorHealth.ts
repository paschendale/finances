import { useQuery } from '@tanstack/react-query';
import { fetchAdvisorHealth } from '@/lib/advisor-api';

export function useAdvisorHealth() {
  return useQuery({
    queryKey: ['advisorHealth'],
    queryFn: () => fetchAdvisorHealth().catch(() => null),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
