import React, { Component, ErrorInfo, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import i18n from '@/lib/i18n'
import { captureError } from '@/lib/diagnostics'

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean
  error?: Error
  errorInfo?: ErrorInfo
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
    // Record it in the shared diagnostics stream so a React crash shows up in
    // the copied diagnostics bundle, not only in a console nobody is watching.
    captureError('ui', error, 'react_error_boundary', {
      componentStack: errorInfo.componentStack ?? undefined,
    })
    this.setState({ errorInfo })
  }

  private getIssueUrl(): string {
    const title = encodeURIComponent(`Crash: ${this.state.error?.message || 'Unknown Error'}`)
    
    // Attempt to get extension version safely
    let extVersion = 'Unknown';
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        extVersion = chrome.runtime.getManifest().version;
      }
    } catch (e) {
      // Ignore
    }

    const body = encodeURIComponent(`
**Describe the bug**
The extension crashed with the following error.

**Error Message**
\`\`\`
${this.state.error?.message || 'N/A'}
\`\`\`

**Stack Trace**
\`\`\`
${this.state.errorInfo?.componentStack || this.state.error?.stack || 'N/A'}
\`\`\`

**Additional Context**
- Extension Version: ${extVersion}
- Browser: ${navigator.userAgent}
    `.trim())
    return `https://github.com/luca-liceti/TraceGuard-Privacy-Extension/issues/new?title=${title}&body=${body}`
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-8">
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle>{i18n.t("Something went wrong")}</CardTitle>
              <CardDescription>
                {this.state.error?.message || 'An unexpected error occurred'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-4">
                  <Button
                    onClick={() => this.setState({ 
                      hasError: false, 
                      error: undefined,
                      errorInfo: undefined
                    })}
                  >
                    {i18n.t("Try again")}</Button>
                  <Button
                    variant="outline"
                    onClick={() => window.open(this.getIssueUrl(), '_blank')}
                  >
                    {i18n.t("Report Issue on GitHub")}</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )
    }

    return this.props.children
  }
}
