'use strict';
class BrowserRegistry {
  constructor() { this._ctx = new Map(); }
  track(accountId, username, opts = {}) {
    this._ctx.set(accountId, { accountId, username, proxyUrl: opts.proxyUrl||null, operationType: opts.operationType||null, parentJobId: opts.parentJobId||null, openedAt: new Date(), lastActivity: new Date(), state: 'opening', currentAction: null });
  }
  setReady(accountId)         { const c=this._ctx.get(accountId); if(c){c.state='ready';c.lastActivity=new Date();} }
  setBusy(accountId, action)  { const c=this._ctx.get(accountId); if(c){c.state='busy';c.currentAction=action;c.lastActivity=new Date();} }
  close(accountId)            { const c=this._ctx.get(accountId); if(c){c.state='closing'; setTimeout(()=>this._ctx.delete(accountId),2000);} }
  getAll()   { return [...this._ctx.values()]; }
  getStats() {
    const all=this.getAll(), limit=parseInt(process.env.BROWSER_LIMIT||'5');
    return { total:all.length, ready:all.filter(c=>c.state==='ready').length, busy:all.filter(c=>c.state==='busy').length, opening:all.filter(c=>c.state==='opening').length, limit, utilization:Math.round((all.length/limit)*100) };
  }
  snapshot() {
    return { stats: this.getStats(), contexts: this.getAll().map(c=>({ username:c.username, state:c.state, operationType:c.operationType, currentAction:c.currentAction, durationSec:Math.round((Date.now()-c.openedAt)/1000) })) };
  }
}
const browserRegistry = new BrowserRegistry();
module.exports = { browserRegistry };
