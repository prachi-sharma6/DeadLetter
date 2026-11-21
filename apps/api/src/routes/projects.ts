import {
  createApiKey,
  deleteProject,
  listApiKeys,
  publicProject,
  revokeApiKey,
  rotateApiKey,
  updateProject,
} from '@deadletter/core';
import { confirmNameSchema, createApiKeySchema, updateProjectSchema } from '@deadletter/shared';
import { requireAuth, requireProject } from '../http/context';
import { ok, parse, route } from '../http/registry';

export const projectRoutes = [
  route({
    method: 'get',
    path: '/projects/:projectId',
    scope: 'project',
    role: 'VIEWER',
    summary: 'Project details',
    handler: (req) => ({ ...publicProject(requireProject(req).project), role: requireProject(req).role }),
  }),
  route({
    method: 'patch',
    path: '/projects/:projectId',
    scope: 'project',
    role: 'ADMIN',
    summary: 'Update project settings',
    handler: async (req, _res, deps) =>
      publicProject(
        await updateProject(deps.db, requireAuth(req).actor, requireProject(req), parse(updateProjectSchema, req.body)),
      ),
  }),
  route({
    method: 'delete',
    path: '/projects/:projectId',
    scope: 'project',
    role: 'ADMIN',
    summary: 'Delete the project and its data (type its name to confirm)',
    handler: async (req, _res, deps) => {
      await deleteProject(
        deps.db,
        requireAuth(req).actor,
        requireProject(req),
        parse(confirmNameSchema, req.body).confirmName,
      );
      return { deleted: true };
    },
  }),
  route({
    method: 'get',
    path: '/projects/:projectId/api-keys',
    scope: 'project',
    role: 'ADMIN',
    summary: 'API keys (never includes the secret)',
    handler: async (req, _res, deps) => listApiKeys(deps.db, requireProject(req).project.id),
  }),
  route({
    method: 'post',
    path: '/projects/:projectId/api-keys',
    scope: 'project',
    role: 'ADMIN',
    verified: true,
    summary: 'Create an API key; the key is returned once and cannot be shown again',
    handler: async (req, res, deps) => {
      const r = await createApiKey(
        deps.db,
        requireAuth(req).actor,
        requireProject(req),
        parse(createApiKeySchema, req.body),
      );
      res.setHeader('cache-control', 'no-store');
      return ok(res, r, 201);
    },
  }),
  route({
    method: 'post',
    path: '/projects/:projectId/api-keys/:keyId/revoke',
    scope: 'project',
    role: 'ADMIN',
    summary: 'Revoke an API key immediately',
    handler: async (req, _res, deps) => {
      await revokeApiKey(deps.db, requireAuth(req).actor, requireProject(req), String(req.params.keyId));
      return { revoked: true };
    },
  }),
  route({
    method: 'post',
    path: '/projects/:projectId/api-keys/:keyId/rotate',
    scope: 'project',
    role: 'ADMIN',
    verified: true,
    summary: 'Replace an API key with a new one and revoke the old one',
    handler: async (req, res, deps) => {
      const r = await rotateApiKey(deps.db, requireAuth(req).actor, requireProject(req), String(req.params.keyId));
      res.setHeader('cache-control', 'no-store');
      return ok(res, r, 201);
    },
  }),
];
