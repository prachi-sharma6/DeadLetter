import type { RouteDef } from '../http/registry';
import { authRoutes } from './auth';
import { orgRoutes } from './orgs';
import { projectRoutes } from './projects';

/** Every console API route. Tests iterate this list to prove tenant isolation for each org/project route. */
export const routes: RouteDef[] = [...authRoutes, ...orgRoutes, ...projectRoutes];
