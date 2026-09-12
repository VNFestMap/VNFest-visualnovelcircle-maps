import { createContext, useContext } from 'react';

export const ClubManagerContext = createContext(null);

export function useClubManager() {
  const value = useContext(ClubManagerContext);
  if (!value) throw new Error('useClubManager must be used inside ClubManagerContext');
  return value;
}
