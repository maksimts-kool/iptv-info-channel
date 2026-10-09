import { createContext } from 'react';

// The customers and plans a private section can be addressed to, handed to the
// section's node view (rendered by TipTap inside the editor's React tree).
export const AudienceContext = createContext({ users: [], plans: [] });
