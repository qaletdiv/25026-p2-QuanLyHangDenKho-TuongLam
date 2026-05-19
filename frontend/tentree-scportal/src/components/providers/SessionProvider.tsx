'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

type UserSession = {
  id: string;
  name: string;
  email: string;
  role: string;
  supplier?: string;
  /** Permission keys for this role — injected at login from roles.json */
  permissions?: string[];
} | null;

type SessionContextType = {
  user: UserSession;
  setUser: React.Dispatch<React.SetStateAction<UserSession>>;
};

const SessionContext = createContext<SessionContextType | undefined>(undefined);

export function SessionProvider({ children, initialUser }: { children: React.ReactNode, initialUser: UserSession }) {
  const [user, setUser] = useState<UserSession>(initialUser);

  useEffect(() => {
    setUser(initialUser);
  }, [initialUser]);

  return (
    <SessionContext.Provider value={{ user, setUser }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const context = useContext(SessionContext);
  if (context === undefined) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return context;
}
