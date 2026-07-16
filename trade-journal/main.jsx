import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import TradeJournalApp from './trade-journal.jsx'
import ProcessLog from './trading-journal.jsx'

function Root() {
  const [view, setView] = useState('journal')

  const btn = (id, label) => (
    <button
      onClick={() => setView(id)}
      style={{
        padding: '8px 20px',
        border: 'none',
        cursor: 'pointer',
        fontSize: 13.5,
        fontWeight: view === id ? 600 : 400,
        borderRadius: 6,
        background: view === id ? '#3FA66A' : 'transparent',
        color: view === id ? '#0B1320' : '#7d8ba1',
        transition: 'background 0.15s',
      }}
    >
      {label}
    </button>
  )

  return (
    <div>
      <div style={{
        background: '#0B1320',
        borderBottom: '1px solid #22304A',
        padding: '8px 20px',
        display: 'flex',
        gap: 6,
      }}>
        {btn('journal', 'Trade Journal')}
        {btn('process', 'Daily Scorecard')}
      </div>
      {view === 'journal' ? <TradeJournalApp /> : <ProcessLog />}
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Root />)
