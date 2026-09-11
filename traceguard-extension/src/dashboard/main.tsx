import React from 'react'
import ReactDOM from 'react-dom/client'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import App from './App'
import '@/styles/globals.css'
import '@/lib/i18n'
import { installGlobalErrorHandlers } from '@/lib/diagnostics'

// Capture uncaught errors thrown anywhere in the dashboard context.
installGlobalErrorHandlers()

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
    </React.StrictMode>,
)
