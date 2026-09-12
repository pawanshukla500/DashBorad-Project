import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error: error.message };
  }

  componentDidCatch(error, info) {
    console.error('Dashboard error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="m-6 rounded-xl border border-rose-200 bg-rose-50 p-6" role="alert">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined mt-0.5 shrink-0 text-[20px] text-rose-500" aria-hidden="true">error</span>
            <div>
              <p className="text-rose-700 font-semibold">Something went wrong</p>
              <p className="text-rose-600 text-sm font-mono mt-1">{this.state.error}</p>
              <button
                type="button"
                onClick={() => { this.setState({ error: null }); window.location.reload(); }}
                className="mt-3 rounded-md text-sm text-rose-700 underline hover:no-underline focus-visible:ring-2 focus-visible:ring-rose-400"
              >
                Try again (reload page)
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
