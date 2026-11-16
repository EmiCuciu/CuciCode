import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const permissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof effortSchema>;

export const attachmentSchema = z.object({
  name: z.string(),
  mediaType: z.string(),
  dataBase64: z.string(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

const chatRef = z.object({ chatId: z.string().min(1) });

export const methodSchemas = {
  ping: z.object({}),
  'chat.open': chatRef.extend({
    cwd: z.string().min(1),
    resume: z.string().optional(),
    forkSession: z.boolean().optional(),
    model: z.string().optional(),
    effort: effortSchema.optional(),
    permissionMode: permissionModeSchema.optional(),
    env: z.record(z.string(), z.string()).optional(),
    allowedTools: z.array(z.string()).optional(),
  }),
  'chat.send': chatRef.extend({
    text: z.string(),
    attachments: z.array(attachmentSchema).optional(),
    priority: z.enum(['now', 'next', 'later']).optional(),
  }),
  'chat.interrupt': chatRef,
  'chat.setModel': chatRef.extend({ model: z.string().optional() }),
  'chat.setPermissionMode': chatRef.extend({ mode: permissionModeSchema }),
  'chat.info': chatRef,
  'chat.rewind': chatRef.extend({ messageId: z.string().min(1), dryRun: z.boolean() }),
  'chat.close': chatRef,
  'permission.respond': z.object({
    requestId: z.string().min(1),
    behavior: z.enum(['allow', 'deny']),
    remember: z.boolean().optional(),
    message: z.string().optional(),
  }),
  'sessions.list': z.object({ cwd: z.string().min(1), limit: z.number().int().positive().optional() }),
  'sessions.messages': z.object({ cwd: z.string().min(1), sessionId: z.string().min(1) }),
  'sessions.rename': z.object({ cwd: z.string().min(1), sessionId: z.string().min(1), title: z.string().min(1) }),
  'sessions.delete': z.object({ cwd: z.string().min(1), sessionId: z.string().min(1) }),
  'sessions.fork': z.object({ cwd: z.string().min(1), sessionId: z.string().min(1) }),
} as const;

export type Method = keyof typeof methodSchemas;
export type MethodParams<M extends Method> = z.infer<(typeof methodSchemas)[M]>;

export const requestEnvelopeSchema = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;

export function isMethod(name: string): name is Method {
  return Object.prototype.hasOwnProperty.call(methodSchemas, name);
}
