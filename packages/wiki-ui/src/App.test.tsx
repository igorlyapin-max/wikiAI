import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'healthy' }), {
    headers: { 'Content-Type': 'application/json' },
  })));
});

describe('WikiUI App', () => {
  it('renders the assistant route by default', () => {
    render(<App initialRoute="assistant" />);

    expect(screen.getByRole('heading', { name: 'AI-помощник' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ассистент' })).toHaveClass('active');
  });

  it('switches to the admin route', async () => {
    const user = userEvent.setup();
    render(<App initialRoute="assistant" />);

    await user.click(screen.getByRole('button', { name: 'Админ' }));

    expect(screen.getByRole('heading', { name: 'Администрирование WikiAI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Админ' })).toHaveClass('active');
  });
});
