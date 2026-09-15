import React, { useState, useEffect, useCallback } from 'react';
import { Trash2, Edit2, Plus, X } from 'lucide-react';
import { fetchAmazonFcMaster, removeAmazonFc, saveAmazonFc } from '../api/client';

export default function AmazonFcSettings() {
  const [fcs, setFcs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState({ fc_code: '', city: '', state: '', fc_type: 'FBA' });
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState(null);

  const fetchFcs = useCallback(async () => {
    try {
      setError(null);
      setFcs(await fetchAmazonFcMaster());
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.error || err.message || 'Failed to fetch FCs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchFcs();
  }, [fetchFcs]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setError(null);
      await saveAmazonFc(formData);
      setIsModalOpen(false);
      setFormData({ fc_code: '', city: '', state: '', fc_type: 'FBA' });
      setIsEditing(false);
      await fetchFcs();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save FC');
    }
  };

  const handleDelete = async (code) => {
    if (!window.confirm(`Are you sure you want to delete FC ${code}?`)) return;
    try {
      setError(null);
      await removeAmazonFc(code);
      await fetchFcs();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to delete FC');
    }
  };

  const openEdit = (fc) => {
    setFormData(fc);
    setIsEditing(true);
    setIsModalOpen(true);
  };

  const openNew = () => {
    setFormData({ fc_code: '', city: '', state: '', fc_type: 'FBA' });
    setIsEditing(false);
    setIsModalOpen(true);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="font-display text-headline-lg font-semibold text-ink">Amazon Fulfillment Centers</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage the list of Amazon FCs to enable accurate local, regional, and national shipping zone calculations.
          </p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus size={18} /> Add New FC
        </button>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 p-4 rounded-lg border border-red-100 flex justify-between items-center">
          <span>{error}</span>
          <button onClick={() => setError(null)}><X size={18} /></button>
        </div>
      )}

      <div className="bg-surface border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-gray-600">
            <thead className="bg-gray-50 text-gray-900 border-b border-gray-200">
              <tr>
                <th className="px-6 py-4 font-semibold">FC Code</th>
                <th className="px-6 py-4 font-semibold">City</th>
                <th className="px-6 py-4 font-semibold">State</th>
                <th className="px-6 py-4 font-semibold">FC Type</th>
                <th className="px-6 py-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan="5" className="px-6 py-8 text-center text-gray-400">Loading...</td>
                </tr>
              ) : fcs.length === 0 ? (
                <tr>
                  <td colSpan="5" className="px-6 py-8 text-center text-gray-400">No FCs found. Add one to get started.</td>
                </tr>
              ) : (
                fcs.map((fc) => (
                  <tr key={fc.fc_code} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-6 py-4 font-medium text-gray-900">{fc.fc_code}</td>
                    <td className="px-6 py-4">{fc.city}</td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                        {fc.state}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${fc.fc_type === 'Flex' ? 'bg-purple-50 text-purple-700' : 'bg-orange-50 text-orange-700'}`}>
                        {fc.fc_type || 'FBA'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right space-x-3">
                      <button
                        onClick={() => openEdit(fc)}
                        className="text-gray-400 hover:text-blue-600 transition-colors"
                        title="Edit FC"
                      >
                        <Edit2 size={16} />
                      </button>
                      <button
                        onClick={() => handleDelete(fc.fc_code)}
                        className="text-gray-400 hover:text-red-600 transition-colors"
                        title="Delete FC"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 modal-backdrop flex items-center justify-center z-50 p-4">
          <div className="bg-surface rounded-xl shadow-xl w-full max-w-md overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <h2 className="text-lg font-semibold text-gray-900">
                {isEditing ? 'Edit Fulfillment Center' : 'Add New Fulfillment Center'}
              </h2>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={20} />
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="flex-1 flex flex-col p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  FC Code (e.g. BOM5)
                </label>
                <input
                  type="text"
                  required
                  disabled={isEditing}
                  value={formData.fc_code}
                  onChange={e => setFormData({ ...formData, fc_code: e.target.value })}
                  className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all disabled:opacity-50"
                  placeholder="FC Code"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Ship From City (e.g. Bhiwandi)
                </label>
                <input
                  type="text"
                  required
                  value={formData.city}
                  onChange={e => setFormData({ ...formData, city: e.target.value })}
                  className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                  placeholder="City"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Ship From State (e.g. MAHARASHTRA)
                </label>
                <input
                  type="text"
                  required
                  value={formData.state}
                  onChange={e => setFormData({ ...formData, state: e.target.value })}
                  className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                  placeholder="State"
                />
                <p className="text-xs text-gray-500 mt-2">
                  State name must match Amazon's region lists exactly (e.g., DELHI, GUJARAT, UTTAR PRADESH).
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  FC Type (FBA or Flex)
                </label>
                <select
                  value={formData.fc_type || 'FBA'}
                  onChange={e => setFormData({ ...formData, fc_type: e.target.value })}
                  className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                >
                  <option value="FBA">FBA (Amazon Fulfillment)</option>
                  <option value="Flex">Flex (Merchant Fulfillment)</option>
                </select>
              </div>

              <div className="pt-4 flex justify-end gap-3 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors shadow-sm"
                >
                  {isEditing ? 'Save Changes' : 'Add FC'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
