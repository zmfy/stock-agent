export interface ApiResponse<T = unknown> {
  success: boolean;
  code: string;
  message?: string;
  data?: T;
  meta?: { requestId: string; timestamp: string };
}

export interface JwtPayload {
  userId: string;
  role: 'admin' | 'user';
}

export interface User {
  id: string;
  username: string;
  password_hash: string;
  role: 'admin' | 'user';
  created_at: string;
}

// Express request augmentation so req.user is typed everywhere.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
