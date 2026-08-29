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
        <div className="m-6 rounded-xl border border-rose-200 bg-rose-50 p-6">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-rose-700 font-semibold">Something went wrong</p>
              <p className="text-rose-600 text-sm font-mono mt-1">{this.state.error}</p>
              <button
                onClick={() => { this.setState({ error: null }); window.location.reload(); }}
                className="mt-3 text-sm text-rose-700 underline hover:no-underline"
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
