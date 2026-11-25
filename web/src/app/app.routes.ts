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
    path: 'booth',
    canActivate: [roleGuard('booth_handler', 'admin')],
    loadComponent: () => import('./booth/booth-console').then((m) => m.BoothConsole),
    title: 'Varisai · Booth',
  },
  { path: '**', redirectTo: '' },
];
