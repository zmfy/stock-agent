import { generateTokens, authMiddleware, adminMiddleware } from './auth';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../secret';

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('auth middleware', () => {
  it('generateTokens issues a 30min access and 30d refresh token', () => {
    const { accessToken, refreshToken } = generateTokens('u1', 'user');
    const a = jwt.verify(accessToken, JWT_SECRET) as any;
    const r = jwt.verify(refreshToken, JWT_SECRET) as any;
    expect(a.userId).toBe('u1');
    expect(a.role).toBe('user');
    expect(a.exp - a.iat).toBe(30 * 60); // 30 minutes
    expect(r.exp - r.iat).toBe(30 * 24 * 60 * 60); // 30 days
  });

  it('authMiddleware rejects a request with no token', () => {
    const req: any = { headers: {} };
    const res = mockRes();
    const next = jest.fn();
    authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('authMiddleware accepts a valid token and populates req.user', () => {
    const { accessToken } = generateTokens('u2', 'admin');
    const req: any = { headers: { authorization: `Bearer ${accessToken}` } };
    const res = mockRes();
    const next = jest.fn();
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.userId).toBe('u2');
    expect(req.user.role).toBe('admin');
  });

  it('adminMiddleware 403s a role:user request', () => {
    const req: any = { user: { userId: 'u3', role: 'user' } };
    const res = mockRes();
    const next = jest.fn();
    adminMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('adminMiddleware passes a role:admin request', () => {
    const req: any = { user: { userId: 'u4', role: 'admin' } };
    const res = mockRes();
    const next = jest.fn();
    adminMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
