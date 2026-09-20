/**
 * WST-FR-02 (backend side): the API is bilingual at the contract level. Every error code carries an
 * English and an Arabic message, chosen with the Accept-Language header. Identifiers (job numbers,
 * VINs, plates, SKUs, amounts) are never translated and stay in LTR form, which is why only the
 * message text is localized and never the data.
 */
export type Locale = 'en' | 'ar';

export const pickLocale = (header?: string): Locale =>
  String(header || '').toLowerCase().startsWith('ar') ? 'ar' : 'en';

export const ERROR_CATALOG: Record<string, { en: string; ar: string }> = {
  VALIDATION_ERROR: { en: 'Request payload failed validation', ar: 'فشل التحقق من صحة البيانات المرسلة' },
  AUTH_REQUIRED: { en: 'Bearer token required', ar: 'مطلوب رمز دخول' },
  AUTH_INVALID: { en: 'Invalid or expired credentials', ar: 'بيانات الدخول غير صحيحة أو منتهية' },
  AUTH_LOCKED: { en: 'Too many failed attempts, try again in 15 minutes', ar: 'محاولات فاشلة كثيرة، حاول بعد ١٥ دقيقة' },
  FORBIDDEN: { en: 'Permission denied', ar: 'لا تملك صلاحية لهذا الإجراء' },
  NOT_FOUND: { en: 'Resource not found', ar: 'العنصر غير موجود' },
  RATE_LIMITED: { en: 'Too many requests', ar: 'عدد الطلبات تجاوز الحد المسموح' },
  DUPLICATE: { en: 'Resource already exists', ar: 'العنصر موجود بالفعل' },
  FK_VIOLATION: { en: 'Referenced resource does not exist', ar: 'العنصر المرتبط غير موجود' },
  JOB_INVALID_TRANSITION: { en: 'This job status change is not allowed', ar: 'انتقال حالة أمر الشغل غير مسموح' },
  CUSTOMER_APPROVAL_REQUIRED: { en: 'Billable work cannot start before customer approval', ar: 'لا يمكن بدء العمل المدفوع قبل موافقة العميل' },
  NO_WORK_RECORDED: { en: 'Record labor before quality check', ar: 'سجّل ساعات العمل قبل فحص الجودة' },
  WORK_ITEMS_INCOMPLETE: { en: 'All required checklist items must be completed first', ar: 'يجب إنهاء كل بنود قائمة العمل المطلوبة أولًا' },
  REASON_REQUIRED: { en: 'A reason is required for this action', ar: 'يجب إدخال سبب لهذا الإجراء' },
  INVOICE_REQUIRED: { en: 'An issued invoice is required before delivery', ar: 'يجب إصدار الفاتورة قبل التسليم' },
  INVOICE_EXISTS: { en: 'This job card already has an invoice', ar: 'يوجد بالفعل فاتورة لأمر الشغل' },
  JOB_NOT_READY: { en: 'Job must reach READY before invoicing', ar: 'يجب أن يصل أمر الشغل لحالة جاهز قبل الفوترة' },
  JOB_CLOSED: { en: 'Job card is closed', ar: 'أمر الشغل مغلق' },
  INVALID_DISCOUNT: { en: 'Discount must be between zero and the computed subtotal', ar: 'الخصم يجب أن يكون بين صفر وإجمالي الفاتورة المحسوب' },
  OVERPAYMENT: { en: 'Payment exceeds the invoice total', ar: 'المبلغ المدفوع أكبر من إجمالي الفاتورة' },
  INSUFFICIENT_STOCK: { en: 'Insufficient available stock', ar: 'الكمية المتاحة في المخزون غير كافية' },
  REVERSAL_EXCEEDS_ISSUED: { en: 'Cannot reverse more than the outstanding issued quantity', ar: 'لا يمكن إرجاع كمية أكبر من المصروفة' },
  ALREADY_INVOICED: { en: 'Credit the invoice before reversing issued parts', ar: 'يجب تعديل الفاتورة قبل إرجاع القطع' },
  RESERVATION_NOT_FOUND: { en: 'No active reservation for this part', ar: 'لا يوجد حجز فعال لهذه القطعة' },
  INVALID_LEVELS: { en: 'Maximum level must be greater than or equal to the minimum level', ar: 'الحد الأقصى يجب أن يكون أكبر من أو يساوي الحد الأدنى' },
  INVALID_TRANSFER: { en: 'Source and destination stores must differ', ar: 'يجب اختلاف المخزن المصدر عن المخزن المستقبل' },
  DUPLICATE_APPROVAL: { en: 'This user has already decided on this request', ar: 'هذا المستخدم اعتمد الطلب بالفعل' },
  SEPARATION_OF_DUTIES: { en: 'The requester of a record cannot approve or sign it', ar: 'لا يجوز لمقدم الطلب اعتماده أو توقيعه' },
  PO_NOT_APPROVED: { en: 'Goods can only be received against an approved purchase order', ar: 'لا يمكن استلام بضاعة إلا على أمر شراء معتمد' },
  OVER_RECEIPT: { en: 'Accepted quantity exceeds the outstanding ordered quantity', ar: 'الكمية المستلمة أكبر من الكمية المطلوبة المتبقية' },
  INVALID_STATE: { en: 'The record is not in a state that allows this action', ar: 'حالة السجل لا تسمح بهذا الإجراء' },
  RESOURCE_CONFLICT: { en: 'Bay, mentor or technician already booked in this window', ar: 'الخليج أو المشرف أو الفني محجوز في نفس الوقت' },
  INVALID_WINDOW: { en: 'The end time must be after the start time', ar: 'وقت النهاية يجب أن يكون بعد وقت البداية' },
  CAPACITY_EXCEEDED: { en: 'Session capacity exceeded', ar: 'تم تجاوز السعة المسموحة للجلسة' },
  NOT_ENROLLED: { en: 'Student is not enrolled in this session', ar: 'الطالب غير مسجل في هذه الجلسة' },
  TASK_NOT_IN_COURSE: { en: 'Task does not belong to this session course', ar: 'المهمة لا تنتمي لمقرر هذه الجلسة' },
  ALREADY_SIGNED: { en: 'A signed assessment cannot be changed', ar: 'لا يمكن تعديل تقييم موقّع' },
  NOT_ELIGIBLE: { en: 'Student does not meet the certification rules', ar: 'الطالب لا يستوفي شروط الحصول على الشهادة' },
  COURSE_REQUIRED: { en: 'courseId query parameter is required', ar: 'يجب تحديد المقرر' },
  UNKNOWN_EXPORT: { en: 'Unknown export dataset', ar: 'مجموعة التصدير غير معروفة' },
  UNKNOWN_MODEL: { en: 'Unknown prediction model', ar: 'النموذج التنبؤي غير معروف' },
  UNKNOWN_ROLE: { en: 'Role does not exist', ar: 'الدور غير موجود' },
  NOT_A_STUDENT: { en: 'No student profile linked to this user', ar: 'لا يوجد ملف طالب مرتبط بهذا المستخدم' },
  ROUTE_NOT_FOUND: { en: 'No such route', ar: 'المسار غير موجود' },
  INTERNAL_ERROR: { en: 'Unexpected error', ar: 'خطأ غير متوقع' },
};

export const localize = (code: string, fallback: string, locale: Locale) =>
  ERROR_CATALOG[code]?.[locale] ?? fallback;
