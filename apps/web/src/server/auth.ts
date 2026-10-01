import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { SESSION_EXPIRES_SECONDS } from '../shared/limits.js';
import type { AppConfig } from './config.js';
import type { DB } from './db/index.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Better Auth owns password hashing and sessions. This module only constrains
 * the signup payload, pins the cookie / session / rate-limit policy, and, in
 * hosted mode, enforces the explicit public origin and configured signup policy.
 */
export function createAuth(db: DB, config: AppConfig) {
  const hosted = config.deployment === 'hosted';
  const signupAllowlist = config.signupEmails;

  return betterAuth({
    appName: 'StripSearch',
    // Explicit origin only: forwarded host/proto headers never influence it.
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.authSecret,
    database: db,
    // Local keeps every loopback origin; hosted trusts the single configured one.
    trustedOrigins: config.allowedOrigins,
    emailAndPassword: {
      enabled: true,
      disableSignUp: false,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 128
    },
    session: {
      expiresIn: SESSION_EXPIRES_SECONDS,
      updateAge: 60 * 60 * 24
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 10 }
      }
    },
    advanced: {
      cookiePrefix: 'stripsearch',
      useSecureCookies: config.secureCookies,
      // Never infer the base URL from X-Forwarded-Host / X-Forwarded-Proto.
      trustedProxyHeaders: false,
      // Migrations are applied explicitly on boot (db/migrate.ts), so runtime
      // schema validation would only log a false mismatch during init.
      database: { validateSchema: false },
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.secureCookies,
        path: '/'
      },
      ...(hosted
        ? {
            // The deployment reverse proxy runs on loopback and overwrites
            // X-Forwarded-For / X-Real-IP with the immediate client IP.
            // Trust is scoped to those loopback hops only.
            ipAddress: {
              ipAddressHeaders: ['x-forwarded-for', 'x-real-ip'],
              trustedProxies: ['127.0.0.1', '::1']
            }
          }
        : {})
    },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const name = typeof user.name === 'string' ? user.name.trim() : '';
            if (name.length < 1 || name.length > 60) {
              throw new APIError('BAD_REQUEST', { message: '显示名称需为 1–60 个字符。' });
            }
            const email = typeof user.email === 'string' ? user.email.trim() : '';
            if (email.length === 0 || email.length > 254 || !EMAIL_RE.test(email)) {
              throw new APIError('BAD_REQUEST', { message: '邮箱格式不正确。' });
            }
            // A configured allowlist constrains registration; null explicitly
            // opens it. An empty list denies new accounts, not existing login.
            if (signupAllowlist && !signupAllowlist.includes(email.toLowerCase())) {
              throw new APIError('FORBIDDEN', {
                message: '该邮箱不在允许注册的名单内。',
                code: 'SIGNUP_NOT_ALLOWED'
              });
            }
            return { data: { ...user, name, email } };
          }
        }
      }
    }
  });
}

export type Auth = ReturnType<typeof createAuth>;
