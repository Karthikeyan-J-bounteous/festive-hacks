import { Routes } from '@angular/router';
import { homeRedirect, roleGuard } from './core/guards';
import { Login } from './login';

export const routes: Routes = [
  { path: '', pathMatch: 'full', canActivate: [homeRedirect], children: [] },
  { path: 'login', component: Login, title: 'Varisai · Log in' },
  {
    path: 'w',
    canActivate: [roleGuard('guest', 'booth_handler', 'admin')],
    loadComponent: () => import('./guest/guest-page').then((m) => m.GuestPage),
    title: 'Varisai',
  },
  {
    path: 'p/:token',
    canActivate: [roleGuard('guest', 'booth_handler', 'admin')],
    loadComponent: () => import('./guest/claim-pass').then((m) => m.ClaimPass),
    title: 'Varisai · Family pass',
  },
  {
    path: 'booth',
    canActivate: [roleGuard('booth_handler', 'admin')],
    loadComponent: () => import('./booth/booth-console').then((m) => m.BoothConsole),
    title: 'Varisai · Booth',
  },
  {
    path: 'admin/venue',
    canActivate: [roleGuard('admin')],
    loadComponent: () => import('./admin/venue-screen').then((m) => m.VenueScreen),
    title: 'Varisai · Venue screen',
  },
  {
    path: 'admin',
    canActivate: [roleGuard('admin')],
    loadComponent: () => import('./admin/admin-shell').then((m) => m.AdminShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      { path: 'overview', loadComponent: () => import('./admin/overview').then((m) => m.OverviewTab), title: 'Varisai · Overview' },
      { path: 'events', loadComponent: () => import('./admin/events').then((m) => m.EventsTab), title: 'Varisai · Events' },
      { path: 'layout', loadComponent: () => import('./admin/layout').then((m) => m.LayoutTab), title: 'Varisai · Layout' },
      { path: 'passes', loadComponent: () => import('./admin/passes').then((m) => m.PassesTab), title: 'Varisai · Passes' },
    ],
  },
  { path: '**', redirectTo: '' },
];
