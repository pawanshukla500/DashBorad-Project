import dataRoutes, { invalidateDashboardReportCache } from './data.js';
import statementRoutes from './statement.js';
import rateCardRoutes from './rateCard.js';
import returnTrackingRoutes from './returnTracking.js';
import amazonUploadRoutes from './amazonUpload.js';
import amazonFcRoutes from './amazonFc.js';
import uploadRoutes from './upload.js';
import myntraUploadRoutes from './myntraUpload.js';
import flipkartSettlementRoutes from './flipkartSettlement.js';
import reconcileRoutes from './reconcile.js';
import chargesRoutes from './charges.js';
import insightsRoutes from './insights.js';
import mpSettlementRoutes from './mpSettlement.js';
import authRoutes from './auth.js';
import auditRoutes from './audit.js';
import exceptionsRoutes from './exceptions.js';
import disputesRoutes from './disputes.js';
import exportRoutes from './export.js';
import uploadHealthRoutes from './uploadHealth.js';
import {
  authMiddleware,
  mutationAccessGuard,
  rateCardAccessGuard,
  requireRole,
} from '../utils/authMiddleware.js';
import { auditMutationMiddleware } from '../services/auditLog.js';

function protectMutations(app, path) {
  app.use(path, mutationAccessGuard);
}

export function mountApiRoutes(app) {
  app.use('/api', auditMutationMiddleware);
  app.use('/api/auth', authRoutes);

  // Everything below this line requires a valid Firebase identity.
  app.use('/api', authMiddleware);

  // The dashboard's short-lived aggregate cache is safe only until a
  // successful write. Invalidate it after every mutation so an upload, rate
  // change, or correction is visible on the next tab load without waiting for
  // its TTL. Failed writes leave the cache untouched.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      res.on('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) invalidateDashboardReportCache();
      });
    }
    next();
  });

  // Read-heavy reports with a small number of explicitly protected commands.
  protectMutations(app, '/api/settlement/push-report');
  app.use('/api', dataRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/exceptions', exceptionsRoutes);

  // Statement routes own the /api/statement namespace used by the frontend.
  protectMutations(app, '/api/statement');
  app.use('/api/statement', statementRoutes);

  protectMutations(app, '/api/amazon-fc');
  app.use('/api', amazonFcRoutes);

  app.use('/api/rate-card', rateCardAccessGuard);
  app.use('/api/rate-card', rateCardRoutes);

  protectMutations(app, '/api/returns');
  app.use('/api/returns', returnTrackingRoutes);

  protectMutations(app, '/api/disputes');
  app.use('/api/disputes', disputesRoutes);
  // Exports contain marketplace financial detail. The UI exposes them to
  // analysts and above, so enforce the same boundary at the API layer.
  app.use('/api/export', requireRole('analyst', 'operator', 'admin'));
  app.use('/api/export', exportRoutes);

  // One canonical upload namespace. Amazon settlement ingestion lives only in
  // amazonUploadRoutes; generic CSV/XLSX uploads remain in uploadRoutes.
  protectMutations(app, '/api/upload');
  // Dedicated layouts: Myntra uses Order Release ID / Order Line ID rather
  // than the generic marketplace header convention.
  app.use('/api/upload/myntra', myntraUploadRoutes);
  app.use('/api/upload', uploadHealthRoutes);
  app.use('/api/upload', amazonUploadRoutes);
  app.use('/api/upload', uploadRoutes);
  app.use('/api/upload/flipkart-settlement', flipkartSettlementRoutes);

  app.use('/api/reconcile', reconcileRoutes);
  app.use('/api/charges', chargesRoutes);
  app.use('/api/insights', insightsRoutes);

  protectMutations(app, '/api/mp-settlement');
  app.use('/api/mp-settlement', mpSettlementRoutes);
}
