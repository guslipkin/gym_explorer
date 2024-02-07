'use strict';

var apacheArrow = require('apache-arrow');
var acorn = require('acorn');
var fetch = require('node-fetch');
var fs = require('fs');

var isArray = Array.isArray;

function toArray(value) {
  return value != null
    ? (isArray(value) ? value : [value])
    : [];
}

/**
 * Generate a table expression that filters a table based on ordered row
 * indices from start to end (end not included), where start and end
 * represent per-group ordered row numbers in the table. The resulting
 * string can be used as the input to the filter verb.
 * @param {number} [start] Zero-based index at which to start extraction.
 *  A negative index indicates an offset from the end of the group.
 *  If start is undefined, slice starts from the index 0.
 * @param {number} [end] Zero-based index before which to end extraction.
 *  A negative index indicates an offset from the end of the group.
 *  If end is omitted, slice extracts through the end of the group.
 * @return {string} A table expression string for slicing values.
 * @example slice(1, -1)
 */
function slice(start = 0, end = Infinity) {
  return `${prep(start)} < row_number() && row_number() <= ${prep(end)}`;
}

function prep(index) {
  return index < 0 ? `count() + ${index}` : index;
}

/**
 * Abstract base class for transforming data.
 */
class Transformable {

  /**
   * Instantiate a new Transformable instance.
   * @param {Params} [params] The parameter values.
   */
  constructor(params) {
    if (params) this._params = params;
  }

  /**
   * Get or set table expression parameter values.
   * If called with no arguments, returns the current parameter values
   * as an object. Otherwise, adds the provided parameters to this
   * table's parameter set and returns the table. Any prior parameters
   * with names matching the input parameters are overridden.
   * @param {Params} [values] The parameter values.
   * @return {this|Params} The current parameters values (if called with
   *  no arguments) or this table.
   */
  params(values) {
    if (arguments.length) {
      if (values) {
        this._params = { ...this._params, ...values };
      }
      return this;
    } else {
      return this._params;
    }
  }

  /**
   * Create a new fully-materialized instance of this table.
   * All filter and orderby settings are removed from the new table.
   * Instead, the backing data itself is filtered and ordered as needed.
   * @param {number[]} [indices] Ordered row indices to materialize.
   *  If unspecified, all rows passing the table filter are used.
   * @return {this} A reified table.
   */
  reify(indices) {
    return this.__reify(this, indices);
  }

  // -- Transformation Verbs ------------------------------------------------

  /**
   * Count the number of values in a group. This method is a shorthand
   * for {@link Transformable#rollup} with a count aggregate function.
   * @param {CountOptions} [options] Options for the count.
   * @return {this} A new table with groupby and count columns.
   * @example table.groupby('colA').count()
   * @example table.groupby('colA').count({ as: 'num' })
   */
  count(options) {
    return this.__count(this, options);
  }

  /**
   * Derive new column values based on the provided expressions. By default,
   * new columns are added after (higher indices than) existing columns. Use
   * the before or after options to place new columns elsewhere.
   * @param {ExprObject} values Object of name-value pairs defining the
   *  columns to derive. The input object should have output column
   *  names for keys and table expressions for values.
   * @param {DeriveOptions} [options] Options for dropping or relocating
   *  derived columns. Use either a before or after property to indicate
   *  where to place derived columns. Specifying both before and after is an
   *  error. Unlike the relocate verb, this option affects only new columns;
   *  updated columns with existing names are excluded from relocation.
   * @return {this} A new table with derived columns added.
   * @example table.derive({ sumXY: d => d.x + d.y })
   * @example table.derive({ z: d => d.x * d.y }, { before: 'x' })
   */
  derive(values, options) {
    return this.__derive(this, values, options);
  }

  /**
   * Filter a table to a subset of rows based on the input criteria.
   * The resulting table provides a filtered view over the original data; no
   * data copy is made. To create a table that copies only filtered data to
   * new data structures, call {@link Transformable#reify} on the output table.
   * @param {TableExpr} criteria Filter criteria as a table expression.
   *  Both aggregate and window functions are permitted, taking into account
   *  {@link Transformable#groupby} or {@link Transformable#orderby} settings.
   * @return {this} A new table with filtered rows.
   * @example table.filter(d => abs(d.value) < 5)
   */
  filter(criteria) {
    return this.__filter(this, criteria);
  }

  /**
   * Extract rows with indices from start to end (end not included), where
   * start and end represent per-group ordered row numbers in the table.
   * @param {number} [start] Zero-based index at which to start extraction.
   *  A negative index indicates an offset from the end of the group.
   *  If start is undefined, slice starts from the index 0.
   * @param {number} [end] Zero-based index before which to end extraction.
   *  A negative index indicates an offset from the end of the group.
   *  If end is omitted, slice extracts through the end of the group.
   * @return {this} A new table with sliced rows.
   * @example table.slice(1, -1)
   */
  slice(start, end) {
    return this.filter(slice(start, end)).reify();
  }

  /**
   * Group table rows based on a set of column values.
   * Subsequent operations that are sensitive to grouping (such as
   * aggregate functions) will operate over the grouped rows.
   * To undo grouping, use {@link Transformable#ungroup}.
   * @param  {...ExprList} keys Key column values to group by.
   *  The keys may be specified using column name strings, column index
   *  numbers, value objects with output column names for keys and table
   *  expressions for values, or selection helper functions.
   * @return {this} A new table with grouped rows.
   * @example table.groupby('colA', 'colB')
   * @example table.groupby({ key: d => d.colA + d.colB })
   */
  groupby(...keys) {
    return this.__groupby(this, keys.flat());
  }

  /**
   * Order table rows based on a set of column values.
   * Subsequent operations sensitive to ordering (such as window functions)
   * will operate over sorted values.
   * The resulting table provides an view over the original data, without
   * any copying. To create a table with sorted data copied to new data
   * strucures, call {@link Transformable#reify} on the result of this method.
   * To undo ordering, use {@link Transformable#unorder}.
   * @param  {...OrderKeys} keys Key values to sort by, in precedence order.
   *  By default, sorting is done in ascending order.
   *  To sort in descending order, wrap values using {@link desc}.
   *  If a string, order by the column with that name.
   *  If a number, order by the column with that index.
   *  If a function, must be a valid table expression; aggregate functions
   *  are permitted, but window functions are not.
   *  If an object, object values must be valid values parameters
   *  with output column names for keys and table expressions
   *  for values (the output names will be ignored).
   *  If an array, array values must be valid key parameters.
   * @return {this} A new ordered table.
   * @example table.orderby('a', desc('b'))
   * @example table.orderby({ a: 'a', b: desc('b') )})
   * @example table.orderby(desc(d => d.a))
   */
  orderby(...keys) {
    return this.__orderby(this, keys.flat());
  }

  /**
   * Relocate a subset of columns to change their positions, also
   * potentially renaming them.
   * @param {Selection} columns An ordered selection of columns to relocate.
   *  The input may consist of column name strings, column integer indices,
   *  rename objects with current column names as keys and new column names
   *  as values, or functions that take a table as input and returns a valid
   *  selection parameter (typically the output of selection helper functions
   *  such as {@link all}, {@link not}, or {@link range}).
   * @param {RelocateOptions} options Options for relocating. Must include
   *  either the before or after property to indicate where to place the
   *  relocated columns. Specifying both before and after is an error.
   * @return {this} A new table with relocated columns.
   * @example table.relocate(['colY', 'colZ'], { after: 'colX' })
   * @example table.relocate(not('colB', 'colC'), { before: 'colA' })
   * @example table.relocate({ colA: 'newA', colB: 'newB' }, { after: 'colC' })
   */
  relocate(columns, options) {
    return this.__relocate(this, toArray(columns), options);
  }

  /**
   * Rename one or more columns, preserving column order.
   * @param {...Select} columns One or more rename objects with current
   *  column names as keys and new column names as values.
   * @return {this} A new table with renamed columns.
   * @example table.rename({ oldName: 'newName' })
   * @example table.rename({ a: 'a2', b: 'b2' })
   */
  rename(...columns) {
    return this.__rename(this, columns.flat());
  }

  /**
   * Rollup a table to produce an aggregate summary.
   * Often used in conjunction with {@link Transformable#groupby}.
   * To produce counts only, {@link Transformable#count} is a shortcut.
   * @param {ExprObject} [values] Object of name-value pairs defining aggregate
   *  output columns. The input object should have output column names for
   *  keys and table expressions for values. The expressions must be valid
   *  aggregate expressions: window functions are not allowed and column
   *  references must be arguments to aggregate functions.
   * @return {this} A new table of aggregate summary values.
   * @example table.groupby('colA').rollup({ mean: d => mean(d.colB) })
   * @example table.groupby('colA').rollup({ mean: op.median('colB') })
   */
  rollup(values) {
    return this.__rollup(this, values);
  }

  /**
   * Generate a table from a random sample of rows.
   * If the table is grouped, performs a stratified sample by
   * sampling from each group separately.
   * @param {number|TableExpr} size The number of samples to draw per group.
   *  If number-valued, the same sample size is used for each group.
   *  If function-valued, the input should be an aggregate table
   *  expression compatible with {@link Transformable#rollup}.
   * @param {SampleOptions} [options] Options for sampling.
   * @return {this} A new table with sampled rows.
   * @example table.sample(50)
   * @example table.sample(100, { replace: true })
   * @example table.groupby('colA').sample(() => op.floor(0.5 * op.count()))
   */
  sample(size, options) {
    return this.__sample(this, size, options);
  }

  /**
   * Select a subset of columns into a new table, potentially renaming them.
   * @param {...Select} columns An ordered selection of columns.
   *  The input may consist of column name strings, column integer indices,
   *  rename objects with current column names as keys and new column names
   *  as values, or functions that take a table as input and returns a valid
   *  selection parameter (typically the output of selection helper functions
   *  such as {@link all}, {@link not}, or {@link range}).
   * @return {this} A new table of selected columns.
   * @example table.select('colA', 'colB')
   * @example table.select(not('colB', 'colC'))
   * @example table.select({ colA: 'newA', colB: 'newB' })
   */
  select(...columns) {
    return this.__select(this, columns.flat());
  }

  /**
   * Ungroup a table, removing any grouping criteria.
   * Undoes the effects of {@link Transformable#groupby}.
   * @return {this} A new ungrouped table, or this table if not grouped.
   * @example table.ungroup()
   */
  ungroup() {
    return this.__ungroup(this);
  }

  /**
   * Unorder a table, removing any sorting criteria.
   * Undoes the effects of {@link Transformable#orderby}.
   * @return {this} A new unordered table, or this table if not ordered.
   * @example table.unorder()
   */
  unorder() {
    return this.__unorder(this);
  }

  // -- Cleaning Verbs ------------------------------------------------------

  /**
   * De-duplicate table rows by removing repeated row values.
   * @param {...ExprList} keys Key columns to check for duplicates.
   *  Two rows are considered duplicates if they have matching values for
   *  all keys. If keys are unspecified, all columns are used.
   *  The keys may be specified using column name strings, column index
   *  numbers, value objects with output column names for keys and table
   *  expressions for values, or selection helper functions.
   * @return {this} A new de-duplicated table.
   * @example table.dedupe()
   * @example table.dedupe('a', 'b')
   * @example table.dedupe({ abs: d => op.abs(d.a) })
   */
  dedupe(...keys) {
    return this.__dedupe(this, keys.flat());
  }

  /**
   * Impute missing values or rows. Accepts a set of column-expression pairs
   * and evaluates the expressions to replace any missing (null, undefined,
   * or NaN) values in the original column.
   * If the expand option is specified, imputes new rows for missing
   * combinations of values. All combinations of key values (a full cross
   * product) are considered for each level of grouping (specified by
   * {@link Transformable#groupby}). New rows will be added for any combination
   * of key and groupby values not already contained in the table. For all
   * non-key and non-group columns the new rows are populated with imputation
   * values (first argument) if specified, otherwise undefined.
   * If the expand option is specified, any filter or orderby settings are
   * removed from the output table, but groupby settings persist.
   * @param {ExprObject} values Object of name-value pairs for the column values
   *  to impute. The input object should have existing column names for keys
   *  and table expressions for values. The expressions will be evaluated to
   *  determine replacements for any missing values.
   * @param {ImputeOptions} [options] Imputation options. The expand
   *  property specifies a set of column values to consider for imputing
   *  missing rows. All combinations of expanded values are considered, and
   *  new rows are added for each combination that does not appear in the
   *  input table.
   * @return {this} A new table with imputed values and/or rows.
   * @example table.impute({ v: () => 0 })
   * @example table.impute({ v: d => op.mean(d.v) })
   * @example table.impute({ v: () => 0 }, { expand: ['x', 'y'] })
   */
  impute(values, options) {
    return this.__impute(this, values, options);
  }

  // -- Reshaping Verbs -----------------------------------------------------

  /**
   * Fold one or more columns into two key-value pair columns.
   * The fold transform is an inverse of the {@link Transformable#pivot} transform.
   * The resulting table has two new columns, one containing the column
   * names (named "key") and the other the column values (named "value").
   * The number of output rows equals the original row count multiplied
   * by the number of folded columns.
   * @param {ExprList} values The columns to fold.
   *  The columns may be specified using column name strings, column index
   *  numbers, value objects with output column names for keys and table
   *  expressions for values, or selection helper functions.
   * @param {FoldOptions} [options] Options for folding.
   * @return {this} A new folded table.
   * @example table.fold('colA')
   * @example table.fold(['colA', 'colB'])
   * @example table.fold(range(5, 8))
   */
  fold(values, options) {
    return this.__fold(this, values, options);
  }

  /**
   * Pivot columns into a cross-tabulation.
   * The pivot transform is an inverse of the {@link Transformable#fold} transform.
   * The resulting table has new columns for each unique combination
   * of the provided *keys*, populated with the provided *values*.
   * The provided *values* must be aggregates, as a single set of keys may
   * include more than one row. If string-valued, the *any* aggregate is used.
   * If only one *values* column is defined, the new pivoted columns will
   * be named using key values directly. Otherwise, input value column names
   * will be included as a component of the output column names.
   * @param {ExprList} keys Key values to map to new column names.
   *  The keys may be specified using column name strings, column index
   *  numbers, value objects with output column names for keys and table
   *  expressions for values, or selection helper functions.
   * @param {ExprList} values Output values for pivoted columns.
   *  Column references will be wrapped in an *any* aggregate.
   *  If object-valued, the input object should have output value
   *  names for keys and aggregate table expressions for values.
   * @param {PivotOptions} [options] Options for pivoting.
   * @return {this} A new pivoted table.
   * @example table.pivot('key', 'value')
   * @example table.pivot(['keyA', 'keyB'], ['valueA', 'valueB'])
   * @example table.pivot({ key: d => d.key }, { value: d => sum(d.value) })
   */
  pivot(keys, values, options) {
    return this.__pivot(this, keys, values, options);
  }

  /**
   * Spread array elements into a set of new columns.
   * Output columns are named based on the value key and array index.
   * @param {ExprList} values The column values to spread.
   *  The values may be specified using column name strings, column index
   *  numbers, value objects with output column names for keys and table
   *  expressions for values, or selection helper functions.
   * @param {SpreadOptions} [options] Options for spreading.
   * @return {this} A new table with the spread columns added.
   * @example table.spread({ a: split(d.text, '') })
   * @example table.spread('arrayCol', { limit: 100 })
   */
  spread(values, options) {
    return this.__spread(this, values, options);
  }

  /**
   * Unroll one or more array-valued columns into new rows.
   * If more than one array value is used, the number of new rows
   * is the smaller of the limit and the largest length.
   * Values for all other columns are copied over.
   * @param {ExprList} values The column values to unroll.
   *  The values may be specified using column name strings, column index
   *  numbers, value objects with output column names for keys and table
   *  expressions for values, or selection helper functions.
   * @param {UnrollOptions} [options] Options for unrolling.
   * @return {this} A new unrolled table.
   * @example table.unroll('colA', { limit: 1000 })
   */
  unroll(values, options) {
    return this.__unroll(this, values, options);
  }

  // -- Joins ---------------------------------------------------------------

  /**
   * Lookup values from a secondary table and add them as new columns.
   * A lookup occurs upon matching key values for rows in both tables.
   * If the secondary table has multiple rows with the same key, only
   * the last observed instance will be considered in the lookup.
   * Lookup is similar to {@link Transformable#join_left}, but with a simpler
   * syntax and the added constraint of allowing at most one match only.
   * @param {TableRef} other The secondary table to look up values from.
   * @param {JoinKeys} [on] Lookup keys (column name strings or table
   *  expressions) for this table and the secondary table, respectively.
   * @param {...ExprList} values The column values to add from the
   *  secondary table. Can be column name strings or objects with column
   *  names as keys and table expressions as values.
   * @return {this} A new table with lookup values added.
   * @example table.lookup(other, ['key1', 'key2'], 'value1', 'value2')
   */
  lookup(other, on, ...values) {
    return this.__lookup(this, other, on, values.flat());
  }

  /**
   * Join two tables, extending the columns of one table with
   * values from the other table. The current table is considered
   * the "left" table in the join, and the new table input is
   * considered the "right" table in the join. By default an inner
   * join is performed, removing all rows that do not match the
   * join criteria. To perform left, right, or full outer joins, use
   * the {@link Transformable#join_left}, {@link Transformable#join_right}, or
   * {@link Transformable#join_full} methods, or provide an options argument.
   * @param {TableRef} other The other (right) table to join with.
   * @param {JoinPredicate} [on] The join criteria for matching table rows.
   *  If unspecified, the values of all columns with matching names
   *  are compared.
   *  If array-valued, a two-element array should be provided, containing
   *  the columns to compare for the left and right tables, respectively.
   *  If a one-element array or a string value is provided, the same
   *  column names will be drawn from both tables.
   *  If function-valued, should be a two-table table expression that
   *  returns a boolean value. When providing a custom predicate, note that
   *  join key values can be arrays or objects, and that normal join
   *  semantics do not consider null or undefined values to be equal (that is,
   *  null !== null). Use the op.equal function to handle these cases.
   * @param {JoinValues} [values] The columns to include in the join output.
   *  If unspecified, all columns from both tables are included; paired
   *  join keys sharing the same column name are included only once.
   *  If array-valued, a two element array should be provided, containing
   *  the columns to include for the left and right tables, respectively.
   *  Array input may consist of column name strings, objects with output
   *  names as keys and single-table table expressions as values, or the
   *  selection helper functions {@link all}, {@link not}, or {@link range}.
   *  If object-valued, specifies the key-value pairs for each output,
   *  defined using two-table table expressions.
   * @param {JoinOptions} [options] Options for the join.
   * @return {this} A new joined table.
   * @example table.join(other, ['keyL', 'keyR'])
   * @example table.join(other, (a, b) => equal(a.keyL, b.keyR))
   */
  join(other, on, values, options) {
    return this.__join(this, other, on, values, options);
  }

  /**
   * Perform a left outer join on two tables. Rows in the left table
   * that do not match a row in the right table will be preserved.
   * This is a convenience method with fixed options for {@link Transformable#join}.
   * @param {TableRef} other The other (right) table to join with.
   * @param {JoinPredicate} [on] The join criteria for matching table rows.
   *  If unspecified, the values of all columns with matching names
   *  are compared.
   *  If array-valued, a two-element array should be provided, containing
   *  the columns to compare for the left and right tables, respectively.
   *  If a one-element array or a string value is provided, the same
   *  column names will be drawn from both tables.
   *  If function-valued, should be a two-table table expression that
   *  returns a boolean value. When providing a custom predicate, note that
   *  join key values can be arrays or objects, and that normal join
   *  semantics do not consider null or undefined values to be equal (that is,
   *  null !== null). Use the op.equal function to handle these cases.
   * @param {JoinValues} [values] The columns to include in the join output.
   *  If unspecified, all columns from both tables are included; paired
   *  join keys sharing the same column name are included only once.
   *  If array-valued, a two element array should be provided, containing
   *  the columns to include for the left and right tables, respectively.
   *  Array input may consist of column name strings, objects with output
   *  names as keys and single-table table expressions as values, or the
   *  selection helper functions {@link all}, {@link not}, or {@link range}.
   *  If object-valued, specifies the key-value pairs for each output,
   *  defined using two-table table expressions.
   * @param {JoinOptions} [options] Options for the join. With this method,
   *  any options will be overridden with {left: true, right: false}.
   * @return {this} A new joined table.
   * @example table.join_left(other, ['keyL', 'keyR'])
   * @example table.join_left(other, (a, b) => equal(a.keyL, b.keyR))
   */
  join_left(other, on, values, options) {
    const opt = { ...options, left: true, right: false };
    return this.__join(this, other, on, values, opt);
  }

  /**
   * Perform a right outer join on two tables. Rows in the right table
   * that do not match a row in the left table will be preserved.
   * This is a convenience method with fixed options for {@link Transformable#join}.
   * @param {TableRef} other The other (right) table to join with.
   * @param {JoinPredicate} [on] The join criteria for matching table rows.
   *  If unspecified, the values of all columns with matching names
   *  are compared.
   *  If array-valued, a two-element array should be provided, containing
   *  the columns to compare for the left and right tables, respectively.
   *  If a one-element array or a string value is provided, the same
   *  column names will be drawn from both tables.
   *  If function-valued, should be a two-table table expression that
   *  returns a boolean value. When providing a custom predicate, note that
   *  join key values can be arrays or objects, and that normal join
   *  semantics do not consider null or undefined values to be equal (that is,
   *  null !== null). Use the op.equal function to handle these cases.
   * @param {JoinValues} [values] The columns to include in the join output.
   *  If unspecified, all columns from both tables are included; paired
   *  join keys sharing the same column name are included only once.
   *  If array-valued, a two element array should be provided, containing
   *  the columns to include for the left and right tables, respectively.
   *  Array input may consist of column name strings, objects with output
   *  names as keys and single-table table expressions as values, or the
   *  selection helper functions {@link all}, {@link not}, or {@link range}.
   *  If object-valued, specifies the key-value pairs for each output,
   *  defined using two-table table expressions.
   * @param {JoinOptions} [options] Options for the join. With this method,
   *  any options will be overridden with {left: false, right: true}.
   * @return {this} A new joined table.
   * @example table.join_right(other, ['keyL', 'keyR'])
   * @example table.join_right(other, (a, b) => equal(a.keyL, b.keyR))
   */
  join_right(other, on, values, options) {
    const opt = { ...options, left: false, right: true };
    return this.__join(this, other, on, values, opt);
  }

  /**
   * Perform a full outer join on two tables. Rows in either the left or
   * right table that do not match a row in the other will be preserved.
   * This is a convenience method with fixed options for {@link Transformable#join}.
   * @param {TableRef} other The other (right) table to join with.
   * @param {JoinPredicate} [on] The join criteria for matching table rows.
   *  If unspecified, the values of all columns with matching names
   *  are compared.
   *  If array-valued, a two-element array should be provided, containing
   *  the columns to compare for the left and right tables, respectively.
   *  If a one-element array or a string value is provided, the same
   *  column names will be drawn from both tables.
   *  If function-valued, should be a two-table table expression that
   *  returns a boolean value. When providing a custom predicate, note that
   *  join key values can be arrays or objects, and that normal join
   *  semantics do not consider null or undefined values to be equal (that is,
   *  null !== null). Use the op.equal function to handle these cases.
   * @param {JoinValues} [values] The columns to include in the join output.
   *  If unspecified, all columns from both tables are included; paired
   *  join keys sharing the same column name are included only once.
   *  If array-valued, a two element array should be provided, containing
   *  the columns to include for the left and right tables, respectively.
   *  Array input may consist of column name strings, objects with output
   *  names as keys and single-table table expressions as values, or the
   *  selection helper functions {@link all}, {@link not}, or {@link range}.
   *  If object-valued, specifies the key-value pairs for each output,
   *  defined using two-table table expressions.
   * @param {JoinOptions} [options] Options for the join. With this method,
   *  any options will be overridden with {left: true, right: true}.
   * @return {this} A new joined table.
   * @example table.join_full(other, ['keyL', 'keyR'])
   * @example table.join_full(other, (a, b) => equal(a.keyL, b.keyR))
   */
  join_full(other, on, values, options) {
    const opt = { ...options, left: true, right: true };
    return this.__join(this, other, on, values, opt);
  }

  /**
   * Produce the Cartesian cross product of two tables. The output table
   * has one row for every pair of input table rows. Beware that outputs
   * may be quite large, as the number of output rows is the product of
   * the input row counts.
   * This is a convenience method for {@link Transformable#join} in which the
   * join criteria is always true.
   * @param {TableRef} other The other (right) table to join with.
   * @param {JoinValues} [values] The columns to include in the output.
   *  If unspecified, all columns from both tables are included.
   *  If array-valued, a two element array should be provided, containing
   *  the columns to include for the left and right tables, respectively.
   *  Array input may consist of column name strings, objects with output
   *  names as keys and single-table table expressions as values, or the
   *  selection helper functions {@link all}, {@link not}, or {@link range}.
   *  If object-valued, specifies the key-value pairs for each output,
   *  defined using two-table table expressions.
   * @param {JoinOptions} [options] Options for the join.
   * @return {this} A new joined table.
   * @example table.cross(other)
   * @example table.cross(other, [['leftKey', 'leftVal'], ['rightVal']])
   */
  cross(other, values, options) {
    return this.__cross(this, other, values, options);
  }

  /**
   * Perform a semi-join, filtering the left table to only rows that
   * match a row in the right table.
   * @param {TableRef} other The other (right) table to join with.
   * @param {JoinPredicate} [on] The join criteria for matching table rows.
   *  If unspecified, the values of all columns with matching names
   *  are compared.
   *  If array-valued, a two-element array should be provided, containing
   *  the columns to compare for the left and right tables, respectively.
   *  If a one-element array or a string value is provided, the same
   *  column names will be drawn from both tables.
   *  If function-valued, should be a two-table table expression that
   *  returns a boolean value. When providing a custom predicate, note that
   *  join key values can be arrays or objects, and that normal join
   *  semantics do not consider null or undefined values to be equal (that is,
   *  null !== null). Use the op.equal function to handle these cases.
   * @return {this} A new filtered table.
   * @example table.semijoin(other)
   * @example table.semijoin(other, ['keyL', 'keyR'])
   * @example table.semijoin(other, (a, b) => equal(a.keyL, b.keyR))
   */
  semijoin(other, on) {
    return this.__semijoin(this, other, on);
  }

  /**
   * Perform an anti-join, filtering the left table to only rows that
   * do *not* match a row in the right table.
   * @param {TableRef} other The other (right) table to join with.
   * @param {JoinPredicate} [on] The join criteria for matching table rows.
   *  If unspecified, the values of all columns with matching names
   *  are compared.
   *  If array-valued, a two-element array should be provided, containing
   *  the columns to compare for the left and right tables, respectively.
   *  If a one-element array or a string value is provided, the same
   *  column names will be drawn from both tables.
   *  If function-valued, should be a two-table table expression that
   *  returns a boolean value. When providing a custom predicate, note that
   *  join key values can be arrays or objects, and that normal join
   *  semantics do not consider null or undefined values to be equal (that is,
   *  null !== null). Use the op.equal function to handle these cases.
   * @return {this} A new filtered table.
   * @example table.antijoin(other)
   * @example table.antijoin(other, ['keyL', 'keyR'])
   * @example table.antijoin(other, (a, b) => equal(a.keyL, b.keyR))
   */
  antijoin(other, on) {
    return this.__antijoin(this, other, on);
  }

  // -- Set Operations ------------------------------------------------------

  /**
   * Concatenate multiple tables into a single table, preserving all rows.
   * This transformation mirrors the UNION_ALL operation in SQL.
   * Only named columns in this table are included in the output.
   * @see Transformable#union
   * @param  {...TableRef} tables A list of tables to concatenate.
   * @return {this} A new concatenated table.
   * @example table.concat(other)
   * @example table.concat(other1, other2)
   * @example table.concat([other1, other2])
   */
  concat(...tables) {
    return this.__concat(this, tables.flat());
  }

  /**
   * Union multiple tables into a single table, deduplicating all rows.
   * This transformation mirrors the UNION operation in SQL. It is
   * similar to {@link Transformable#concat} but suppresses duplicate rows with
   * values identical to another row.
   * Only named columns in this table are included in the output.
   * @see Transformable#concat
   * @param  {...TableRef} tables A list of tables to union.
   * @return {this} A new unioned table.
   * @example table.union(other)
   * @example table.union(other1, other2)
   * @example table.union([other1, other2])
   */
  union(...tables) {
    return this.__union(this, tables.flat());
  }

  /**
   * Intersect multiple tables, keeping only rows whose with identical
   * values for all columns in all tables, and deduplicates the rows.
   * This transformation is similar to a series of {@link Transformable#semijoin}
   * calls, but additionally suppresses duplicate rows.
   * @see Transformable#semijoin
   * @param  {...TableRef} tables A list of tables to intersect.
   * @return {this} A new filtered table.
   * @example table.intersect(other)
   * @example table.intersect(other1, other2)
   * @example table.intersect([other1, other2])
   */
  intersect(...tables) {
    return this.__intersect(this, tables.flat());
  }

  /**
   * Compute the set difference with multiple tables, keeping only rows in
   * this table that whose values do not occur in the other tables.
   * This transformation is similar to a series of {@link Transformable#antijoin}
   * calls, but additionally suppresses duplicate rows.
   * @see Transformable#antijoin
   * @param  {...TableRef} tables A list of tables to difference.
   * @return {this} A new filtered table.
   * @example table.except(other)
   * @example table.except(other1, other2)
   * @example table.except([other1, other2])
   */
  except(...tables) {
    return this.__except(this, tables.flat());
  }
}

// -- Parameter Types -------------------------------------------------------

/**
 * Table expression parameters.
 * @typedef {Object.<string, *>} Params
 */

/**
 * A reference to a column by string name or integer index.
 * @typedef {string|number} ColumnRef
 */

/**
 * A value that can be coerced to a string.
 * @typedef {object} Stringable
 * @property {() => string} toString String coercion method.
 */

/**
 * A table expression provided as a string or string-coercible value.
 * @typedef {string|Stringable} TableExprString
 */

/**
 * A struct object with arbitraty named properties.
 * @typedef {Object.<string, *>} Struct
 */

/**
 * A function defined over a table row.
 * @typedef {(d?: Struct, $?: Params) => any} TableExprFunc
 */

/**
 * A table expression defined over a single table.
 * @typedef {TableExprFunc|TableExprString} TableExpr
 */

/**
 * A function defined over rows from two tables.
 * @typedef {(a?: Struct, b?: Struct, $?: Params) => any} TableFunc2
 */

/**
 * A table expression defined over two tables.
 * @typedef {TableExprFunc2|TableExprString} TableExpr2
 */

/**
 * An object that maps current column names to new column names.
 * @typedef {{ [name: string]: string }} RenameMap
 */

/**
 * A selection helper function.
 * @typedef {(table: any) => string[]} SelectHelper
 */

/**
 * One or more column selections, potentially with renaming.
 * The input may consist of a column name string, column integer index, a
 * rename map object with current column names as keys and new column names
 * as values, or a select helper function that takes a table as input and
 * returns a valid selection parameter.
 * @typedef {ColumnRef|RenameMap|SelectHelper} SelectEntry
 */

/**
 * An ordered set of column selections, potentially with renaming.
 * @typedef {SelectEntry|SelectEntry[]} Select
 */

/**
 * An object of column name / table expression pairs.
 * @typedef {{ [name: string]: TableExpr }} ExprObject
 */

/**
 * An object of column name / two-table expression pairs.
 * @typedef {{ [name: string]: TableExpr2 }} Expr2Object
 */

/**
 * An ordered set of one or more column values.
 * @typedef {ColumnRef|SelectHelper|ExprObject} ListEntry
 */

/**
 * An ordered set of column values.
 * Entries may be column name strings, column index numbers, value objects
 * with output column names for keys and table expressions for values,
 * or a selection helper function.
 * @typedef {ListEntry|ListEntry[]} ExprList
 */

/**
 * A reference to a data table or transformable instance.
 * @typedef {Transformable|string} TableRef
 */

/**
 * One or more orderby sort criteria.
 * If a string, order by the column with that name.
 * If a number, order by the column with that index.
 * If a function, must be a valid table expression; aggregate functions
 *  are permitted, but window functions are not.
 * If an object, object values must be valid values parameters
 *  with output column names for keys and table expressions
 *  for values. The output name keys will subsequently be ignored.
 * @typedef {ColumnRef|TableExpr|ExprObject} OrderKey
 */

/**
 * An ordered set of orderby sort criteria, in precedence order.
 * @typedef {OrderKey|OrderKey[]} OrderKeys
 */

/**
 * Column values to use as a join key.
 * @typedef {ColumnRef|TableExprFunc} JoinKey
 */

/**
 * An ordered set of join keys.
 * @typedef {JoinKey|[JoinKey[]]|[JoinKey[], JoinKey[]]} JoinKeys
 */

/**
 * A predicate specification for joining two tables.
 * @typedef {JoinKeys|TableExprFunc2|null} JoinPredicate
 */

/**
 * An array of per-table join values to extract.
 * @typedef {[ExprList]|[ExprList, ExprList]|[ExprList, ExprList, Expr2Object]} JoinList
 */

/**
 * A specification of join values to extract.
 * @typedef {JoinList|Expr2Object} JoinValues
 */

// -- Transform Options -----------------------------------------------------

/**
 * Options for count transformations.
 * @typedef {object} CountOptions
 * @property {string} [as='count'] The name of the output count column.
 */

/**
 * Options for derive transformations.
 * @typedef {object} DeriveOptions
 * @property {boolean} [drop=false] A flag indicating if the original
 *  columns should be dropped, leaving only the derived columns. If true,
 *  the before and after options are ignored.
 * @property {Select} [before]
 *  An anchor column that relocated columns should be placed before.
 *  The value can be any legal column selection. If multiple columns are
 *  selected, only the first column will be used as an anchor.
 *  It is an error to specify both before and after options.
 * @property {Select} [after]
 *  An anchor column that relocated columns should be placed after.
 *  The value can be any legal column selection. If multiple columns are
 *  selected, only the last column will be used as an anchor.
 *  It is an error to specify both before and after options.
 */

/**
 * Options for relocate transformations.
 * @typedef {object} RelocateOptions
 * @property {Selection} [before]
 *  An anchor column that relocated columns should be placed before.
 *  The value can be any legal column selection. If multiple columns are
 *  selected, only the first column will be used as an anchor.
 *  It is an error to specify both before and after options.
 * @property {Selection} [after]
 *  An anchor column that relocated columns should be placed after.
 *  The value can be any legal column selection. If multiple columns are
 *  selected, only the last column will be used as an anchor.
 *  It is an error to specify both before and after options.
 */

/**
 * Options for sample transformations.
 * @typedef {object} SampleOptions
 * @property {boolean} [replace=false] Flag for sampling with replacement.
 * @property {boolean} [shuffle=true] Flag to ensure randomly ordered rows.
 * @property {string|TableExprFunc} [weight] Column values to use as weights
 *  for sampling. Rows will be sampled with probability proportional to
 *  their relative weight. The input should be a column name string or
 *  a table expression compatible with {@link Transformable#derive}.
 */

/**
 * Options for impute transformations.
 * @typedef {object} ImputeOptions
 * @property {ExprList} [expand] Column values to combine to impute missing
 *  rows. For column names and indices, all unique column values are
 *  considered. Otherwise, each entry should be an object of name-expresion
 *  pairs, with valid table expressions for {@link Transformable#rollup}.
 *  All combinations of values are checked for each set of unique groupby
 *  values.
 */

/**
 * Options for fold transformations.
 * @typedef {object} FoldOptions
 * @property {string[]} [as=['key', 'value']] An array indicating the
 *  output column names to use for the key and value columns, respectively.
 */

/**
 * Options for pivot transformations.
 * @typedef {object} PivotOptions
 * @property {number} [limit=Infinity] The maximum number of new columns to generate.
 * @property {string} [keySeparator='_'] A string to place between multiple key names.
 * @property {string} [valueSeparator='_'] A string to place between key and value names.
 * @property {boolean} [sort=true] Flag for alphabetical sorting of new column names.
 */

/**
 * Options for spread transformations.
 * @typedef {object} SpreadOptions
 * @property {boolean} [drop=true] Flag indicating if input columns to the
 *  spread operation should be dropped in the output table.
 * @property {number} [limit=Infinity] The maximum number of new columns to
 *  generate.
 * @property {string[]} [as] Output column names to use. This option only
 *  applies when a single column is spread. If the given array of names is
 *  shorter than the number of generated columns and no limit option is
 *  specified, the additional generated columns will be dropped.
 */

/**
 * Options for unroll transformations.
 * @typedef {object} UnrollOptions
 * @property {number} [limit=Infinity] The maximum number of new rows
 *  to generate per array value.
 * @property {boolean|string} [index=false] Flag or column name for adding
 *  zero-based array index values as an output column. If true, a new column
 *  named "index" will be included. If string-valued, a new column with
 *  the given name will be added.
 * @property {Select} [drop] Columns to drop from the output. The input may
 *  consist of column name strings, column integer indices, objects with
 *  column names as keys, or functions that take a table as input and
 *  return a valid selection parameter (typically the output of selection
 *  helper functions such as {@link all}, {@link not}, or {@link range}).
 */

/**
 * Options for join transformations.
 * @typedef {object} JoinOptions
 * @property {boolean} [left=false] Flag indicating a left outer join.
 *  If both the *left* and *right* are true, indicates a full outer join.
 * @property {boolean} [right=false] Flag indicating a right outer join.
 *  If both the *left* and *right* are true, indicates a full outer join.
 * @property {string[]} [suffix=['_1', '_2']] Column name suffixes to
 *  append if two columns with the same name are produced by the join.
 */

function error(message) {
  throw Error(message);
}

function isNumber(value) {
  return typeof value === 'number';
}

function isFunction(value) {
  return typeof value === 'function';
}

function repeat(reps, value) {
  const result = Array(reps);
  if (isFunction(value)) {
    for (let i = 0; i < reps; ++i) {
      result[i] = value(i);
    }
  } else {
    result.fill(value);
  }
  return result;
}

/**
 * Abstract class representing a data table.
 */
class Table extends Transformable {

  /**
   * Instantiate a new Table instance.
   * @param {string[]} names An ordered list of column names.
   * @param {number} nrows The number of rows.
   * @param {TableData} data The backing data, which can vary by implementation.
   * @param {BitSet} [filter] A bit mask for which rows to include.
   * @param {GroupBySpec} [groups] A groupby specification for grouping ows.
   * @param {RowComparator} [order] A comparator function for sorting rows.
   * @param {Params} [params] Parameter values for table expressions.
   */
  constructor(names, nrows, data, filter, groups, order, params) {
    super(params);
    this._names = Object.freeze(names);
    this._data = data;
    this._total = nrows;
    this._nrows = filter ? filter.count() : nrows;
    this._mask = (nrows !== this._nrows && filter) || null;
    this._group = groups || null;
    this._order = order || null;
  }

  /**
   * Create a new table with the same type as this table.
   * The new table may have different data, filter, grouping, or ordering
   * based on the values of the optional configuration argument. If a
   * setting is not specified, it is inherited from the current table.
   * @param {CreateOptions} [options] Creation options for the new table.
   * @return {this} A newly created table.
   */
  create(options) { // eslint-disable-line no-unused-vars
    error('Not implemented');
  }

  /**
   * Provide an informative object string tag.
   */
  get [Symbol.toStringTag]() {
    if (!this._names) return 'Object'; // bail if called on prototype
    const nr = this.numRows() + ' row' + (this.numRows() !== 1 ? 's' : '');
    const nc = this.numCols() + ' col' + (this.numCols() !== 1 ? 's' : '');
    return `Table: ${nc} x ${nr}`
      + (this.isFiltered() ? ` (${this.totalRows()} backing)` : '')
      + (this.isGrouped() ? `, ${this._group.size} groups` : '')
      + (this.isOrdered() ? ', ordered' : '');
  }

  /**
   * Indicates if the table has a filter applied.
   * @return {boolean} True if filtered, false otherwise.
   */
  isFiltered() {
    return !!this._mask;
  }

  /**
   * Indicates if the table has a groupby specification.
   * @return {boolean} True if grouped, false otherwise.
   */
  isGrouped() {
    return !!this._group;
  }

  /**
   * Indicates if the table has a row order comparator.
   * @return {boolean} True if ordered, false otherwise.
   */
  isOrdered() {
    return !!this._order;
  }

  /**
   * Returns the internal table storage data structure.
   * @return {TableData} The backing table storage data structure.
   */
  data() {
    return this._data;
  }

  /**
   * Returns the filter bitset mask, if defined.
   * @return {BitSet} The filter bitset mask.
   */
  mask() {
    return this._mask;
  }

  /**
   * Returns the groupby specification, if defined.
   * @return {GroupBySpec} The groupby specification.
   */
  groups() {
    return this._group;
  }

  /**
   * Returns the row order comparator function, if specified.
   * @return {RowComparator} The row order comparator function.
   */
  comparator() {
    return this._order;
  }

  /**
   * The total number of rows in this table, counting both
   * filtered and unfiltered rows.
   * @return {number} The number of total rows.
   */
  totalRows() {
    return this._total;
  }

  /**
   * The number of active rows in this table. This number may be
   * less than the total rows if the table has been filtered.
   * @see Table.totalRows
   * @return {number} The number of rows.
   */
  numRows() {
    return this._nrows;
  }

  /**
   * The number of active rows in this table. This number may be
   * less than the total rows if the table has been filtered.
   * @see Table.totalRows
   * @return {number} The number of rows.
   */
  get size() {
    return this._nrows;
  }

  /**
   * The number of columns in this table.
   * @return {number} The number of columns.
   */
  numCols() {
    return this._names.length;
  }

  /**
   * Filter function invoked for each column name.
   * @callback NameFilter
   * @param {string} name The column name.
   * @param {number} index The column index.
   * @param {string[]} array The array of names.
   * @return {boolean} Returns true to retain the column name.
   */

  /**
   * The table column names, optionally filtered.
   * @param {NameFilter} [filter] An optional filter function.
   *  If unspecified, all column names are returned.
   * @return {string[]} An array of matching column names.
   */
  columnNames(filter) {
    return filter ? this._names.filter(filter) : this._names.slice();
  }

  /**
   * The column name at the given index.
   * @param {number} index The column index.
   * @return {string} The column name,
   *  or undefined if the index is out of range.
   */
  columnName(index) {
    return this._names[index];
  }

  /**
   * The column index for the given name.
   * @param {string} name The column name.
   * @return {number} The column index, or -1 if the name is not found.
   */
  columnIndex(name) {
    return this._names.indexOf(name);
  }

  /**
   * Deprecated alias for the table array() method: use table.array()
   * instead. Get an array of values contained in a column. The resulting
   * array respects any table filter or orderby criteria.
   * @param {string} name The column name.
   * @param {ArrayConstructor|TypedArrayConstructor} [constructor=Array]
   *  The array constructor for instantiating the output array.
   * @return {DataValue[]|TypedArray} The array of column values.
   */
  columnArray(name, constructor) {
    return this.array(name, constructor);
  }

  /**
   * Get an array of values contained in a column. The resulting array
   * respects any table filter or orderby criteria.
   * @param {string} name The column name.
   * @param {ArrayConstructor|TypedArrayConstructor} [constructor=Array]
   *  The array constructor for instantiating the output array.
   * @return {DataValue[]|TypedArray} The array of column values.
   */
  array(name, constructor) { // eslint-disable-line no-unused-vars
    error('Not implemented');
  }

  /**
   * Returns an iterator over column values.
   * @return {Iterator<object>} An iterator over row objects.
   */
  *values(name) {
    const get = this.getter(name);
    const n = this.numRows();
    for (let i = 0; i < n; ++i) {
      yield get(i);
    }
  }

  /**
   * Get the value for the given column and row.
   * @param {string} name The column name.
   * @param {number} [row=0] The row index, defaults to zero if not specified.
   * @return {DataValue} The data value at (column, row).
   */
  get(name, row = 0) { // eslint-disable-line no-unused-vars
    error('Not implemented');
  }

  /**
   * Returns an accessor ("getter") function for a column. The returned
   * function takes a row index as its single argument and returns the
   * corresponding column value.
   * @param {string} name The column name.
   * @return {ColumnGetter} The column getter function.
   */
  getter(name) { // eslint-disable-line no-unused-vars
    error('Not implemented');
  }

  /**
   * Returns an array of objects representing table rows.
   * @param {ObjectsOptions} [options] The options for row object generation.
   * @return {RowObject[]} An array of row objects.
   */
  objects(options) { // eslint-disable-line no-unused-vars
    error('Not implemented');
  }

  /**
   * Returns an object representing a table row.
   * @param {number} [row=0] The row index, defaults to zero if not specified.
   * @return {object} A row object with named properties for each column.
   */
   object(row) { // eslint-disable-line no-unused-vars
    error('Not implemented');
  }

  /**
   * Returns an iterator over objects representing table rows.
   * @return {Iterator<object>} An iterator over row objects.
   */
  [Symbol.iterator]() {
    error('Not implemented');
  }

  /**
   * Print the contents of this table using the console.table() method.
   * @param {PrintOptions|number} options The options for row object
   *  generation, determining which rows and columns are printed. If
   *  number-valued, specifies the row limit.
   * @return {this} The table instance.
   */
  print(options = {}) {
    if (isNumber(options)) {
      options = { limit: options };
    } else if (options.limit == null) {
      options.limit = 10;
    }

    const obj = this.objects({ ...options, grouped: false });
    const msg = `${this[Symbol.toStringTag]}. Showing ${obj.length} rows.`;

    console.log(msg);   // eslint-disable-line no-console
    console.table(obj); // eslint-disable-line no-console
    return this;
  }

  /**
   * Returns an array of indices for all rows passing the table filter.
   * @param {boolean} [order=true] A flag indicating if the returned
   *  indices should be sorted if this table is ordered. If false, the
   *  returned indices may or may not be sorted.
   * @return {Uint32Array} An array of row indices.
   */
  indices(order = true) {
    if (this._index) return this._index;

    const n = this.numRows();
    const index = new Uint32Array(n);
    const ordered = this.isOrdered();
    const bits = this.mask();
    let row = -1;

    // inline the following for performance:
    // this.scan(row => index[++i] = row);
    if (bits) {
      for (let i = bits.next(0); i >= 0; i = bits.next(i + 1)) {
        index[++row] = i;
      }
    } else {
      for (let i = 0; i < n; ++i) {
        index[++row] = i;
      }
    }

    // sort index vector
    if (order && ordered) {
      const compare = this._order;
      const data = this._data;
      index.sort((a, b) => compare(a, b, data));
    }

    // save indices if they reflect table metadata
    if (order || !ordered) {
      this._index = index;
    }

    return index;
  }

  /**
   * Returns an array of indices for each group in the table.
   * If the table is not grouped, the result is the same as
   * {@link indices}, but wrapped within an array.
   * @param {boolean} [order=true] A flag indicating if the returned
   *  indices should be sorted if this table is ordered. If false, the
   *  returned indices may or may not be sorted.
   * @return {number[][]} An array of row index arrays, one per group.
   *  The indices will be filtered if the table is filtered.
   */
  partitions(order = true) {
    // return partitions if already generated
    if (this._partitions) {
      return this._partitions;
    }

    // if not grouped, return a single partition
    if (!this.isGrouped()) {
      return [ this.indices(order) ];
    }

    // generate partitions
    const { keys, size } = this._group;
    const part = repeat(size, () => []);

    // populate partitions, don't sort if indices don't exist
    // inline the following for performance:
    // this.scan(row => part[keys[row]].push(row), sort);
    const sort = this._index;
    const bits = this.mask();
    const n = this.numRows();
    if (sort && this.isOrdered()) {
      for (let i = 0, r; i < n; ++i) {
        r = sort[i];
        part[keys[r]].push(r);
      }
    } else if (bits) {
      for (let i = bits.next(0); i >= 0; i = bits.next(i + 1)) {
        part[keys[i]].push(i);
      }
    } else {
      for (let i = 0; i < n; ++i) {
        part[keys[i]].push(i);
      }
    }

    // if ordered but not yet sorted, sort partitions directly
    if (order && !sort && this.isOrdered()) {
      const compare = this._order;
      const data = this._data;
      for (let i = 0; i < size; ++i) {
        part[i].sort((a, b) => compare(a, b, data));
      }
    }

    // save partitions if they reflect table metadata
    if (order || !this.isOrdered()) {
      this._partitions = part;
    }

    return part;
  }

  /**
   * Callback function to cancel a table scan.
   * @callback ScanStop
   * @return {void}
   */

  /**
   * Callback function invoked for each row of a table scan.
   * @callback ScanVisitor
   * @param {number} [row] The table row index.
   * @param {TableData} [data] The backing table data store.
   * @param {ScanStop} [stop] Function to stop the scan early.
   *  Callees can invoke this function to prevent future calls.
   * @return {void}
   */

  /**
   * Perform a table scan, visiting each row of the table.
   * If this table is filtered, only rows passing the filter are visited.
   * @param {ScanVisitor} fn Callback invoked for each row of the table.
   * @param {boolean} [order=false] Indicates if the table should be
   *  scanned in the order determined by {@link Table#orderby}. This
   *  argument has no effect if the table is unordered.
   * @property {number} [limit=Infinity] The maximum number of objects to create.
   * @property {number} [offset=0] The row offset indicating how many initial rows to skip.
   */
  scan(fn, order, limit = Infinity, offset = 0) {
    const filter = this._mask;
    const nrows = this._nrows;
    const data = this._data;

    let i = offset || 0;
    if (i > nrows) return;

    const n = Math.min(nrows, i + limit);
    const stop = () => i = this._total;

    if (order && this.isOrdered() || filter && this._index) {
      const index = this.indices();
      const data = this._data;
      for (; i < n; ++i) {
        fn(index[i], data, stop);
      }
    } else if (filter) {
      let c = n - i + 1;
      for (i = filter.nth(i); --c && i > -1; i = filter.next(i + 1)) {
        fn(i, data, stop);
      }
    } else {
      for (; i < n; ++i) {
        fn(i, data, stop);
      }
    }
  }

  /**
   * Extract rows with indices from start to end (end not included), where
   * start and end represent per-group ordered row numbers in the table.
   * @param {number} [start] Zero-based index at which to start extraction.
   *  A negative index indicates an offset from the end of the group.
   *  If start is undefined, slice starts from the index 0.
   * @param {number} [end] Zero-based index before which to end extraction.
   *  A negative index indicates an offset from the end of the group.
   *  If end is omitted, slice extracts through the end of the group.
   * @return {this} A new table with sliced rows.
   * @example table.slice(1, -1)
   */
  slice(start = 0, end = Infinity) {
    if (this.isGrouped()) return super.slice(start, end);

    // if not grouped, scan table directly
    const indices = [];
    const nrows = this.numRows();
    start = Math.max(0, start + (start < 0 ? nrows : 0));
    end = Math.min(nrows, Math.max(0, end + (end < 0 ? nrows : 0)));
    this.scan(row => indices.push(row), true, end - start, start);
    return this.reify(indices);
  }

  /**
   * Reduce a table, processing all rows to produce a new table.
   * To produce standard aggregate summaries, use {@link rollup}.
   * This method allows the use of custom reducer implementations,
   * for example to produce multiple rows for an aggregate.
   * @param {Reducer} reducer The reducer to apply.
   * @return {Table} A new table of reducer outputs.
   */
  reduce(reducer) {
    return this.__reduce(this, reducer);
  }
}

/**
 * A typed array constructor.
 * @typedef {Uint8ArrayConstructor|Uint16ArrayConstructor|Uint32ArrayConstructor|BigUint64ArrayConstructor|Int8ArrayConstructor|Int16ArrayConstructor|Int32ArrayConstructor|BigInt64ArrayConstructor|Float32ArrayConstructor|Float64ArrayConstructor} TypedArrayConstructor
 */

/**
 * A typed array instance.
 * @typedef {Uint8Array|Uint16Array|Uint32Array|BigUint64Array|Int8Array|Int16Array|Int32Array|BigInt64Array|Float32Array|Float64Array} TypedArray
 */

/**
 * Backing table data.
 * @typedef {object|Array} TableData
 */

/**
 * Table value.
 * @typedef {*} DataValue
 */

/**
 * Table row object.
 * @typedef {Object.<string, DataValue>} RowObject
 */

/**
 * Table expression parameters.
 * @typedef {import('./transformable').Params} Params
 */

/**
 * Proxy type for BitSet class.
 * @typedef {import('./bit-set').default} BitSet
 */

/**
 * A table groupby specification.
 * @typedef {object} GroupBySpec
 * @property {number} size The number of groups.
 * @property {string[]} names Column names for each group.
 * @property {RowExpression[]} get Value accessor functions for each group.
 * @property {number[]} rows Indices of an example table row for each group.
 * @property {number[]} keys Per-row group indices, length is total rows of table.
 */

/**
 * Column value accessor.
 * @callback ColumnGetter
 * @param {number} [row] The table row.
 * @return {DataValue}
 */

/**
 * An expression evaluated over a table row.
 * @callback RowExpression
 * @param {number} [row] The table row.
 * @param {TableData} [data] The backing table data store.
 * @return {DataValue}
 */

/**
 * Comparator function for sorting table rows.
 * @callback RowComparator
 * @param {number} rowA The table row index for the first row.
 * @param {number} rowB The table row index for the second row.
 * @param {TableData} data The backing table data store.
 * @return {number} Negative if rowA < rowB, positive if
 *  rowA > rowB, otherwise zero.
 */

/**
 * Options for derived table creation.
 * @typedef {object} CreateOptions
 * @property {TableData} [data] The backing column data.
 * @property {string[]} [names] An ordered list of column names.
 * @property {BitSet} [filter] An additional filter BitSet to apply.
 * @property {GroupBySpec} [groups] The groupby specification to use, or null for no groups.
 * @property {RowComparator} [order] The orderby comparator function to use, or null for no order.
 */

/**
 * Options for generating row objects.
 * @typedef {object} PrintOptions
 * @property {number} [limit=Infinity] The maximum number of objects to create.
 * @property {number} [offset=0] The row offset indicating how many initial rows to skip.
 * @property {import('../table/transformable').Select} [columns]
 *  An ordered set of columns to include. The input may consist of column name
 *  strings, column integer indices, objects with current column names as keys
 *  and new column names as values (for renaming), or selection helper
 *  functions such as {@link all}, {@link not}, or {@link range}.
 */

/**
 * Options for generating row objects.
 * @typedef {object} ObjectsOptions
 * @property {number} [limit=Infinity] The maximum number of objects to create.
 * @property {number} [offset=0] The row offset indicating how many initial rows to skip.
 * @property {import('../table/transformable').Select} [columns]
 *  An ordered set of columns to include. The input may consist of column name
 *  strings, column integer indices, objects with current column names as keys
 *  and new column names as values (for renaming), or selection helper
 *  functions such as {@link all}, {@link not}, or {@link range}.
 * @property {'map'|'entries'|'object'|boolean} [grouped=false]
 *  The export format for groups of rows. The default (false) is to ignore
 *  groups, returning a flat array of objects. The valid values are 'map' or
 *  true (for Map instances), 'object' (for standard objects), or 'entries'
 *  (for arrays in the style of Object.entries). For the 'object' format,
 *  groupby keys are coerced to strings to use as object property names; note
 *  that this can lead to undesirable behavior if the groupby keys are object
 *  values. The 'map' and 'entries' options preserve the groupby key values.
 */

/**
 * Class representing an array-backed data column.
 */
let Column$1 = class Column {
  /**
   * Create a new column instance.
   * @param {Array} data The backing array (or array-like object)
   *  containing the column data.
   */
  constructor(data) {
    this.data = data;
  }

  /**
   * Get the length (number of rows) of the column.
   * @return {number} The length of the column array.
   */
  get length() {
    return this.data.length;
  }

  /**
   * Get the column value at the given row index.
   * @param {number} row The row index of the value to retrieve.
   * @return {import('./table').DataValue} The column value.
   */
  get(row) {
    return this.data[row];
  }

  /**
   * Returns an iterator over the column values.
   * @return {Iterator<object>} An iterator over column values.
   */
  [Symbol.iterator]() {
    return this.data[Symbol.iterator]();
  }
};

/**
 * Column interface. Any object that adheres to this interface
 * can be used as a data column within a {@link ColumnTable}.
 * @typedef {object} ColumnType
 * @property {number} length
 *  The length (number of rows) of the column.
 * @property {import('./table').ColumnGetter} get
 *  Column value getter.
 */

/**
 * Column factory function interface.
 * @callback ColumnFactory
 * @param {*} data The input column data.
 * @return {ColumnType} A column instance.
 */

/**
 * Create a new column from the given input data.
 * @param {any} data The backing column data. If the value conforms to
 *  the Column interface it is returned directly. If the value is an
 *  array, it will be wrapped in a new Column instance.
 * @return {ColumnType} A compatible column instance.
 */
let defaultColumnFactory = function(data) {
  return data && isFunction(data.get) ? data : new Column$1(data);
};

/**
 * Get or set the default factory function for instantiating table columns.
 * @param {ColumnFactory} [factory] The new default factory.
 * @return {ColumnFactory} The current default column factory.
 */
function columnFactory(factory) {
  return arguments.length
    ? (defaultColumnFactory = factory)
    : defaultColumnFactory;
}

function isDate(value) {
  return value instanceof Date;
}

function isObject(value) {
  return value === Object(value);
}

function isRegExp(value) {
  return value instanceof RegExp;
}

function isString(value) {
  return typeof value === 'string';
}

function columnsFrom(values, names) {
  const raise = type => error(`Illegal argument type: ${type || typeof values}`);
  return values instanceof Map ? fromKeyValuePairs(values.entries(), names)
    : isDate(values) ? raise('Date')
    : isRegExp(values) ? raise('RegExp')
    : isString(values) ? raise()
    : isArray(values) ? fromArray(values, names)
    : isFunction(values[Symbol.iterator]) ? fromIterable(values, names)
    : isObject(values) ? fromKeyValuePairs(Object.entries(values), names)
    : raise();
}

function fromKeyValuePairs(entries, names = ['key', 'value']) {
  const keys = [];
  const vals = [];

  for (const [key, val] of entries) {
    keys.push(key);
    vals.push(val);
  }

  const columns = {};
  if (names[0]) columns[names[0]] = keys;
  if (names[1]) columns[names[1]] = vals;
  return columns;
}

function fromArray(values, names) {
  const len = values.length;
  const columns = {};
  const add = name => columns[name] = Array(len);

  if (len) {
    names = names || Object.keys(values[0]);
    const cols = names.map(add);
    const n = cols.length;
    for (let idx = 0; idx < len; ++idx) {
      const row = values[idx];
      for (let i = 0; i < n; ++i) {
        cols[i][idx] = row[names[i]];
      }
    }
  } else if (names) {
    names.forEach(add);
  }

  return columns;
}

function fromIterable(values, names) {
  const columns = {};
  const add = name => columns[name] = [];

  let cols;
  let n;
  for (const row of values) {
    if (!cols) {
      names = names || Object.keys(row);
      cols = names.map(add);
      n = cols.length;
    }
    for (let i = 0; i < n; ++i) {
      cols[i].push(row[names[i]]);
    }
  }

  if (!cols && names) {
    names.forEach(add);
  }

  return columns;
}

const { hasOwnProperty } = Object.prototype;

function has(object, property) {
  return hasOwnProperty.call(object, property);
}

function columnSet(table) {
  return table
    ? new ColumnSet({ ...table.data() }, table.columnNames())
    : new ColumnSet();
}

class ColumnSet {
  constructor(data, names) {
    this.data = data || {};
    this.names = names || [];
  }

  add(name, values) {
    if (!this.has(name)) this.names.push(name + '');
    return this.data[name] = values;
  }

  has(name) {
    return has(this.data, name);
  }

  new() {
    this.filter = null;
    this.groups = this.groups || null;
    this.order = null;
    return this;
  }

  groupby(groups) {
    this.groups = groups;
    return this;
  }
}

/**
 * Default NULL (missing) value to use.
 */
var NULL = undefined;

const TypedArray = Object.getPrototypeOf(Int8Array);

function isTypedArray(value) {
  return value instanceof TypedArray;
}

function isArrayType(value) {
  return isArray(value) || isTypedArray(value);
}

function isValid(value) {
  return value != null && value === value;
}

const isSeq = (seq) => isArrayType(seq) || isString(seq);

var array$2 = {
  compact:      (arr) => isArrayType(arr) ? arr.filter(v => isValid(v)) : arr,
  concat:       (...values) => [].concat(...values),
  includes:     (seq, value, index) => isSeq(seq)
                  ? seq.includes(value, index)
                  : false,
  indexof:      (seq, value) => isSeq(seq) ? seq.indexOf(value) : -1,
  join:         (arr, delim) => isArrayType(arr) ? arr.join(delim) : NULL,
  lastindexof:  (seq, value) => isSeq(seq) ? seq.lastIndexOf(value) : -1,
  length:       (seq) => isSeq(seq) ? seq.length : 0,
  pluck:        (arr, prop) => isArrayType(arr)
                  ? arr.map(v => isValid(v) ? v[prop] : NULL)
                  : NULL,
  reverse:      (seq) => isArrayType(seq) ? seq.slice().reverse()
                  : isString(seq) ? seq.split('').reverse().join('')
                  : NULL,
  slice:        (seq, start, end) => isSeq(seq) ? seq.slice(start, end) : NULL
};

/**
 * Truncate a value to a bin boundary.
 * Useful for creating equal-width histograms.
 * Values outside the [min, max] range will be mapped to
 * -Infinity (< min) or +Infinity (> max).
 * @param {number} value - The value to bin.
 * @param {number} min - The minimum bin boundary.
 * @param {number} max - The maximum bin boundary.
 * @param {number} step - The step size between bin boundaries.
 * @param {number} [offset=0] - Offset in steps by which to adjust
 *  the bin value. An offset of 1 will return the next boundary.
 */
function bin$1(value, min, max, step, offset) {
  return value == null ? null
    : value < min ? -Infinity
    : value > max ? +Infinity
    : (
        value = Math.max(min, Math.min(value, max)),
        min + step * Math.floor(1e-14 + (value - min) / step + (offset || 0))
      );
}

function pad(value, width, char = '0') {
  const s = value + '';
  const len = s.length;
  return len < width ? Array(width - len + 1).join(char) + s : s;
}

const pad2 = v => (v < 10 ? '0' : '') + v;

const formatYear = year => year < 0 ? '-' + pad(-year, 6)
  : year > 9999 ? '+' + pad(year, 6)
  : pad(year, 4);

function formatISO(year, month, date, hours, min, sec, ms, utc, short) {
  const suffix = utc ? 'Z' : '';
  return formatYear(year) + '-' + pad2(month + 1) + '-' + pad2(date) + (
    !short || ms ? 'T' + pad2(hours) + ':' + pad2(min) + ':' + pad2(sec) + '.' + pad(ms, 3) + suffix
    : sec ? 'T' + pad2(hours) + ':' + pad2(min) + ':' + pad2(sec) + suffix
    : min || hours || !utc ? 'T' + pad2(hours) + ':' + pad2(min) + suffix
    : ''
  );
}

function formatDate(d, short) {
  return isNaN(d)
    ? 'Invalid Date'
    : formatISO(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      d.getSeconds(),
      d.getMilliseconds(),
      false, short
    );
}

function formatUTCDate(d, short) {
  return isNaN(d)
    ? 'Invalid Date'
    : formatISO(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
      true, short
    );
}

const iso_re = /^([-+]\d{2})?\d{4}(-\d{2}(-\d{2})?)?(T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?(Z|[-+]\d{2}:\d{2})?)?$/;

function isISODateString(value) {
  return value.match(iso_re) && !isNaN(Date.parse(value));
}

function parseIsoDate(value, parse = Date.parse) {
  return isISODateString(value) ? parse(value) : value;
}

const msMinute = 6e4;
const msDay = 864e5;
const msWeek = 6048e5;

const t0 = new Date();
const t1 = new Date();
const t = d => (
  t0.setTime(typeof d === 'string' ? parseIsoDate(d) : d),
  t0
);

/**
 * Function to create a new Date value.
 * If no arguments are provided, the current time is used.
 * @param {number} [year] The year.
 * @param {number} [month=0] The (zero-based) month.
 * @param {number} [date=1] The date within the month.
 * @param {number} [hours=0] The hour within the day.
 * @param {number} [minutes=0] The minute within the hour.
 * @param {number} [seconds=0] The second within the minute.
 * @param {number} [milliseconds=0] The milliseconds within the second.
 * @return {date} The resuting Date value.
 */
function datetime(year, month, date, hours, minutes, seconds, milliseconds) {
  return !arguments.length
    ? new Date(Date.now())
    : new Date(
        year,
        month || 0,
        date == null ? 1 : date,
        hours || 0,
        minutes || 0,
        seconds || 0,
        milliseconds || 0
      );
}

/**
 * Function to create a new Date value according to UTC time.
 * If no arguments are provided, the current time is used.
 * @param {number} [year] The year.
 * @param {number} [month=0] The (zero-based) month.
 * @param {number} [date=1] The date within the month.
 * @param {number} [hours=0] The hour within the day.
 * @param {number} [minutes=0] The minute within the hour.
 * @param {number} [seconds=0] The second within the minute.
 * @param {number} [milliseconds=0] The milliseconds within the second.
 * @return {date} The resuting Date value.
 */
function utcdatetime(year, month, date, hours, minutes, seconds, milliseconds) {
  return !arguments.length
    ? new Date(Date.now())
    : new Date(Date.UTC(
        year,
        month || 0,
        date == null ? 1 : date,
        hours || 0,
        minutes || 0,
        seconds || 0,
        milliseconds || 0
      ));
}

function dayofyear(date) {
  t1.setTime(+date);
  t1.setHours(0, 0, 0, 0);
  t0.setTime(+t1);
  t0.setMonth(0);
  t0.setDate(1);
  const tz = (t1.getTimezoneOffset() - t0.getTimezoneOffset()) * msMinute;
  return Math.floor(1 + ((t1 - t0) - tz) / msDay);
}

function utcdayofyear(date) {
  t1.setTime(+date);
  t1.setUTCHours(0, 0, 0, 0);
  const t0 = Date.UTC(t1.getUTCFullYear(), 0, 1);
  return Math.floor(1 + (t1 - t0) / msDay);
}

function week(date, firstday) {
  const i = firstday || 0;
  t1.setTime(+date);
  t1.setDate(t1.getDate() - (t1.getDay() + 7 - i) % 7);
  t1.setHours(0, 0, 0, 0);
  t0.setTime(+date);
  t0.setMonth(0);
  t0.setDate(1);
  t0.setDate(1 - (t0.getDay() + 7 - i) % 7);
  t0.setHours(0, 0, 0, 0);
  const tz = (t1.getTimezoneOffset() - t0.getTimezoneOffset()) * msMinute;
  return Math.floor((1 + (t1 - t0) - tz) / msWeek);
}

function utcweek(date, firstday) {
  const i = firstday || 0;
  t1.setTime(+date);
  t1.setUTCDate(t1.getUTCDate() - (t1.getUTCDay() + 7 - i) % 7);
  t1.setUTCHours(0, 0, 0, 0);
  t0.setTime(+date);
  t0.setUTCMonth(0);
  t0.setUTCDate(1);
  t0.setUTCDate(1 - (t0.getUTCDay() + 7 - i) % 7);
  t0.setUTCHours(0, 0, 0, 0);
  return Math.floor((1 + (t1 - t0)) / msWeek);
}

var date = {
  format_date:     (date, shorten) => formatDate(t(date), !shorten),
  format_utcdate:  (date, shorten) => formatUTCDate(t(date), !shorten),
  timestamp:       (date) => +t(date),
  year:            (date) => t(date).getFullYear(),
  quarter:         (date) => Math.floor(t(date).getMonth() / 3),
  month:           (date) => t(date).getMonth(),
  date:            (date) => t(date).getDate(),
  dayofweek:       (date) => t(date).getDay(),
  hours:           (date) => t(date).getHours(),
  minutes:         (date) => t(date).getMinutes(),
  seconds:         (date) => t(date).getSeconds(),
  milliseconds:    (date) => t(date).getMilliseconds(),
  utcyear:         (date) => t(date).getUTCFullYear(),
  utcquarter:      (date) => Math.floor(t(date).getUTCMonth() / 3),
  utcmonth:        (date) => t(date).getUTCMonth(),
  utcdate:         (date) => t(date).getUTCDate(),
  utcdayofweek:    (date) => t(date).getUTCDay(),
  utchours:        (date) => t(date).getUTCHours(),
  utcminutes:      (date) => t(date).getUTCMinutes(),
  utcseconds:      (date) => t(date).getUTCSeconds(),
  utcmilliseconds: (date) => t(date).getUTCMilliseconds(),
  datetime,
  dayofyear,
  week,
  utcdatetime,
  utcdayofyear,
  utcweek,
  now: Date.now
};

/**
 * Compare two values for equality, using join semantics in which null
 * !== null. If the inputs are object-valued, a deep equality check
 * of array entries or object key-value pairs is performed.
 * @param {*} a The first input.
 * @param {*} b The second input.
 * @return {boolean} True if equal, false if not.
 */
function equal(a, b) {
  return (a == null || b == null || a !== a || b !== b) ? false
    : a === b ? true
    : (isDate(a) || isDate(b)) ? +a === +b
    : (isRegExp(a) && isRegExp(b)) ? a + '' === b + ''
    : (isObject(a) && isObject(b)) ? deepEqual(a, b)
    : false;
}

function deepEqual(a, b) {
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
    return false;
  }

  if (a.length || b.length) {
    return arrayEqual(a, b);
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  keysA.sort();
  keysB.sort();

  if (!arrayEqual(keysA, keysB, (a, b) => a === b)) {
    return false;
  }

  const n = keysA.length;
  for (let i = 0; i < n; ++i) {
    const k = keysA[i];
    if (!equal(a[k], b[k])) {
      return false;
    }
  }

  return true;
}

function arrayEqual(a, b, test = equal) {
  const n = a.length;
  if (n !== b.length) return false;

  for (let i = 0; i < n; ++i) {
    if (!test(a[i], b[i])) {
      return false;
    }
  }

  return true;
}

var json = {
  parse_json: (str) => JSON.parse(str),
  to_json:    (val) => JSON.stringify(val)
};

let source = Math.random;

function random() {
  return source();
}

/**
 * Set a seed value for random number generation.
 * If the seed is a valid number, a 32-bit linear congruential generator
 * with the given seed will be used to generate random values.
 * If the seed is null, undefined, or not a valid number, the random
 * number generator will revert to Math.random.
 * @param {number} seed The random seed value. Should either be an
 *  integer or a fraction between 0 and 1.
 */
function seed(seed) {
  source = isValid(seed) && isFinite(seed = +seed) ? lcg(seed) : Math.random;
}

function lcg(seed) {
  const a = 0x19660D;
  const c = 0x3C6EF35F;
  const m = 1 / 0x100000000;
  seed = (0 <= seed && seed < 1 ? seed / m : Math.abs(seed)) | 0;

  // Random numbers using a Linear Congruential Generator with seed value
  // https://en.wikipedia.org/wiki/Linear_congruential_generator
  return () => (seed = a * seed + c | 0, m * (seed >>> 0));
}

var math = {
  random,
  is_nan:    Number.isNaN,
  is_finite: Number.isFinite,

  abs:      Math.abs,
  cbrt:     Math.cbrt,
  ceil:     Math.ceil,
  clz32:    Math.clz32,
  exp:      Math.exp,
  expm1:    Math.expm1,
  floor:    Math.floor,
  fround:   Math.fround,
  greatest: Math.max,
  least:    Math.min,
  log:      Math.log,
  log10:    Math.log10,
  log1p:    Math.log1p,
  log2:     Math.log2,
  pow:      Math.pow,
  round:    Math.round,
  sign:     Math.sign,
  sqrt:     Math.sqrt,
  trunc:    Math.trunc,

  degrees:  (rad) => 180 * rad / Math.PI,
  radians:  (deg) => Math.PI * deg / 180,
  acos:     Math.acos,
  acosh:    Math.acosh,
  asin:     Math.asin,
  asinh:    Math.asinh,
  atan:     Math.atan,
  atan2:    Math.atan2,
  atanh:    Math.atanh,
  cos:      Math.cos,
  cosh:     Math.cosh,
  sin:      Math.sin,
  sinh:     Math.sinh,
  tan:      Math.tan,
  tanh:     Math.tanh
};

function isMap(value) {
  return value instanceof Map;
}

function isSet(value) {
  return value instanceof Set;
}

function isMapOrSet(value) {
  return isMap(value) || isSet(value);
}

function array$1(iter) {
  return Array.from(iter);
}

var object = {
  has:      (obj, key) => isMapOrSet(obj) ? obj.has(key)
              : obj != null ? has(obj, key)
              : false,
  keys:     (obj) => isMap(obj) ? array$1(obj.keys())
              : obj != null ? Object.keys(obj)
              : [],
  values:   (obj) => isMapOrSet(obj) ? array$1(obj.values())
              : obj != null ? Object.values(obj)
              : [],
  entries:  (obj) => isMapOrSet(obj) ? array$1(obj.entries())
              : obj != null ? Object.entries(obj)
              : [],
  object:   (entries) => entries ? Object.fromEntries(entries) : NULL
};

/**
 * Recodes an input value to an alternative value, based on a provided
 * value map. If a fallback value is specified, it will be returned when
 * a matching value is not found in the map; otherwise, the input value
 * is returned unchanged.
 * @param {*} value The value to recode. The value must be safely
 *  coercible to a string for lookup against the value map.
 * @param {object|Map} map An object or Map with input values for keys and
 *  output recoded values as values. If a non-Map object, only the object's
 *  own properties will be considered.
 * @param {*} [fallback] A default fallback value to use if the input
 *  value is not found in the value map.
 * @return {*} The recoded value.
 */
function recode(value, map, fallback) {
  if (map instanceof Map) {
    if (map.has(value)) return map.get(value);
  } else if (has(map, value)) {
    return map[value];
  }
  return fallback !== undefined ? fallback : value;
}

/**
 * Returns an array containing an arithmetic sequence from the start value
 * to the stop value, in step increments. If step is positive, the last
 * element is the largest start + i * step less than stop; if step is
 * negative, the last element is the smallest start + i * step greater
 * than stop. If the returned array would contain an infinite number of
 * values, an empty range is returned.
 * @param {number} [start=0] The starting value of the sequence.
 * @param {number} [stop] The stopping value of the sequence.
 *  The stop value is exclusive; it is not included in the result.
 * @param {number} [step=1] The step increment between sequence values.
 * @return {number[]} The generated sequence.
 */
function sequence(start, stop, step) {
  let n = arguments.length;
  start = +start;
  stop = +stop;
  step = n < 2
    ? (stop = start, start = 0, 1)
    : n < 3 ? 1 : +step;

  n = Math.max(0, Math.ceil((stop - start) / step)) | 0;
  const seq = new Array(n);

  for (let i = 0; i < n; ++i) {
    seq[i] = start + i * step;
  }

  return seq;
}

var string = {
  parse_date:   (str) => str == null ? str : new Date(str),
  parse_float:  (str) => str == null ? str : Number.parseFloat(str),
  parse_int:    (str, radix) => str == null ? str : Number.parseInt(str, radix),
  endswith:     (str, search, length) => str == null ? false
                  : String(str).endsWith(search, length),
  match:        (str, regexp, index) => {
                  const m = str == null ? str : String(str).match(regexp);
                  return index == null || m == null ? m
                    : typeof index === 'number' ? m[index]
                    : m.groups ? m.groups[index]
                    : null;
                },
  normalize:    (str, form) => str == null ? str
                  : String(str).normalize(form),
  padend:       (str, len, fill) => str == null ? str
                  : String(str).padEnd(len, fill),
  padstart:     (str, len, fill) => str == null ? str
                  : String(str).padStart(len, fill),
  upper:        (str) => str == null ? str
                  : String(str).toUpperCase(),
  lower:        (str) => str == null ? str
                  : String(str).toLowerCase(),
  repeat:       (str, num) => str == null ? str
                  : String(str).repeat(num),
  replace:      (str, pattern, replacement) => str == null ? str
                  : String(str).replace(pattern, String(replacement)),
  substring:    (str, start, end) => str == null ? str
                  : String(str).substring(start, end),
  split:        (str, separator, limit) => str == null ? []
                  : String(str).split(separator, limit),
  startswith:   (str, search, length) => str == null ? false
                  : String(str).startsWith(search, length),
  trim:         (str) => str == null ? str
                  : String(str).trim()
};

var functions = {
  bin: bin$1,
  equal,
  recode,
  sequence,
  ...array$2,
  ...date,
  ...json,
  ...math,
  ...object,
  ...string
};

function isBigInt(value) {
  return typeof value === 'bigint';
}

function toString(v) {
  return v === undefined ? v + ''
    : isBigInt(v) ? v + 'n'
    : JSON.stringify(v);
}

function op(name, fields = [], params = []) {
  return new Op$1(name, toArray(fields), toArray(params));
}

let Op$1 = class Op {
  constructor(name, fields, params) {
    this.name = name;
    this.fields = fields;
    this.params = params;
  }
  toString() {
    const args = [
      ...this.fields.map(f => `d[${toString(f)}]`),
      ...this.params.map(toString)
    ];
    return `d => op.${this.name}(${args})`;
  }
  toObject() {
    return { expr: this.toString(), func: true };
  }
};

const any = (field) => op('any', field);
const count = () => op('count');
const array_agg = (field) => op('array_agg', field);
const array_agg_distinct = (field) => op('array_agg_distinct', field);
const map_agg = (key, value) => op('map_agg', [key, value]);
const object_agg = (key, value) => op('object_agg', [key, value]);
const entries_agg = (key, value) => op('entries_agg', [key, value]);

/**
 * @typedef {import('../table/transformable').Struct} Struct
 */

/**
 * All table expression operations including normal functions,
 * aggregate functions, and window functions.
 */
var ops = {
  ...functions,

  /**
   * Generate an object representing the current table row.
   * @param {...string} names The column names to include in the object.
   *  If unspecified, all columns are included.
   * @return {Struct} The generated row object.
   */
  row_object: (...names) => op('row_object', null, names.flat()),

  /**
   * Aggregate function to count the number of records (rows).
   * @returns {number} The count of records.
   */
  count,

  /**
   * Aggregate function returning an arbitrary observed value.
   * @param {*} field The data field.
   * @return {*} An arbitrary observed value.
   */
  any,

  /**
   * Aggregate function to collect an array of values.
   * @param {*} field The data field.
   * @return {Array} A list of values.
   */
  array_agg,

  /**
   * Aggregate function to collect an array of distinct (unique) values.
   * @param {*} field The data field.
   * @return {Array} An array of unique values.
   */
  array_agg_distinct,

  /**
   * Aggregate function to create an object given input key and value fields.
   * @param {*} key The object key field.
   * @param {*} value The object value field.
   * @return {Struct} An object of key-value pairs.
   */
  object_agg,

  /**
   * Aggregate function to create a Map given input key and value fields.
   * @param {*} key The object key field.
   * @param {*} value The object value field.
   * @return {Map} A Map of key-value pairs.
   */
  map_agg,

  /**
   * Aggregate function to create an array in the style of Object.entries()
   * given input key and value fields.
   * @param {*} key The object key field.
   * @param {*} value The object value field.
   * @return {[[any, any]]} An array of [key, value] arrays.
   */
  entries_agg,

  /**
   * Aggregate function to count the number of valid values.
   * Invalid values are null, undefined, or NaN.
   * @param {*} field The data field.
   * @return {number} The count of valid values.
   */
  valid: (field) => op('valid', field),

  /**
   * Aggregate function to count the number of invalid values.
   * Invalid values are null, undefined, or NaN.
   * @param {*} field The data field.
   * @return {number} The count of invalid values.
   */
  invalid: (field) => op('invalid', field),

  /**
   * Aggregate function to count the number of distinct values.
   * @param {*} field The data field.
   * @return {number} The count of distinct values.
   */
  distinct: (field) => op('distinct', field),

  /**
   * Aggregate function to determine the mode (most frequent) value.
   * @param {*} field The data field.
   * @return {number} The mode value.
   */
  mode: (field) => op('mode', field),

  /**
   * Aggregate function to sum values.
   * @param {string} field The data field.
   * @return {number} The sum of the values.
   */
  sum: (field) => op('sum', field),

  /**
   * Aggregate function to multiply values.
   * @param {*} field The data field.
   * @return {number} The product of the values.
   */
  product: (field) => op('product', field),

  /**
   * Aggregate function for the mean (average) value.
   * @param {*} field The data field.
   * @return {number} The mean (average) of the values.
   */
  mean: (field) => op('mean', field),

  /**
   * Aggregate function for the average (mean) value.
   * @param {*} field The data field.
   * @return {number} The average (mean) of the values.
   */
  average: (field) => op('average', field),

  /**
   * Aggregate function for the sample variance.
   * @param {*} field The data field.
   * @return {number} The sample variance of the values.
   */
  variance: (field) => op('variance', field),

  /**
   * Aggregate function for the population variance.
   * @param {*} field The data field.
   * @return {number} The population variance of the values.
   */
  variancep: (field) => op('variancep', field),

  /**
   * Aggregate function for the sample standard deviation.
   * @param {*} field The data field.
   * @return {number} The sample standard deviation of the values.
   */
  stdev: (field) => op('stdev', field),

  /**
   * Aggregate function for the population standard deviation.
   * @param {*} field The data field.
   * @return {number} The population standard deviation of the values.
   */
  stdevp: (field) => op('stdevp', field),

  /**
   * Aggregate function for the minimum value.
   * @param {*} field The data field.
   * @return {number} The minimum value.
   */
  min: (field) => op('min', field),

  /**
   * Aggregate function for the maximum value.
   * @param {*} field The data field.
   * @return {number} The maximum value.
   */
  max: (field) => op('max', field),

  /**
   * Aggregate function to compute the quantile boundary
   * of a data field for a probability threshold.
   * @param {*} field The data field.
   * @param {number} p The probability threshold.
   * @return {number} The quantile value.
   */
  quantile: (field, p) => op('quantile', field, p),

  /**
   * Aggregate function for the median value.
   * This is a shorthand for the 0.5 quantile value.
   * @param {*} field The data field.
   * @return {number} The median value.
   */
  median: (field) => op('median', field),

  /**
   * Aggregate function for the sample covariance between two variables.
   * @param {*} field1 The first data field.
   * @param {*} field2 The second data field.
   * @return {number} The sample covariance of the values.
   */
  covariance: (field1, field2) => op('covariance', [field1, field2]),

  /**
   * Aggregate function for the population covariance between two variables.
   * @param {*} field1 The first data field.
   * @param {*} field2 The second data field.
   * @return {number} The population covariance of the values.
   */
  covariancep: (field1, field2) => op('covariancep', [field1, field2]),

  /**
   * Aggregate function for the product-moment correlation between two variables.
   * To instead compute a rank correlation, compute the average ranks for each
   * variable and then apply this function to the result.
   * @param {*} field1 The first data field.
   * @param {*} field2 The second data field.
   * @return {number} The correlation between the field values.
   */
  corr: (field1, field2) => op('corr', [field1, field2]),

  /**
   * Aggregate function for calculating a binning scheme in terms of
   * the minimum bin boundary, maximum bin boundary, and step size.
   * @param {*} field The data field.
   * @param {number} [maxbins=15] The maximum number of allowed bins.
   * @param {boolean} [nice=true] Flag indicating if the bin min and max
   *  should snap to "nice" human-friendly values.
   * @param {number} [minstep] The minimum allowed step size between bins.
   * @param {number} [step] The exact step size to use between bins.
   *  If specified, the maxbins and minstep arguments are ignored.
   * @return {[number, number, number]} The bin [min, max, and step] values.
   */
  bins: (field, maxbins, nice, minstep) =>
    op('bins', field, [maxbins, nice, minstep]),

  /**
   * Window function to assign consecutive row numbers, starting from 1.
   * @return {number} The row number value.
   */
  row_number: () => op('row_number'),

  /**
   * Window function to assign a rank to each value in a group, starting
   * from 1. Peer values are assigned the same rank. Subsequent ranks
   * reflect the number of prior values: if the first two values tie for
   * rank 1, the third value is assigned rank 3.
   * @return {number} The rank value.
   */
  rank: () => op('rank'),

  /**
   * Window function to assign a fractional (average) rank to each value in
   * a group, starting from 1. Peer values are assigned the average of their
   * indices: if the first two values tie, both will be assigned rank 1.5.
   * @return {number} The peer-averaged rank value.
   */
  avg_rank: () => op('avg_rank'),

  /**
   * Window function to assign a dense rank to each value in a group,
   * starting from 1. Peer values are assigned the same rank. Subsequent
   * ranks do not reflect the number of prior values: if the first two
   * values tie for rank 1, the third value is assigned rank 2.
   * @return {number} The dense rank value.
   */
  dense_rank: () => op('dense_rank'),

  /**
   * Window function to assign a percentage rank to each value in a group.
   * The percent is calculated as (rank - 1) / (group_size - 1).
   * @return {number} The percentage rank value.
   */
  percent_rank: () => op('percent_rank'),

  /**
   * Window function to assign a cumulative distribution value between 0 and 1
   * to each value in a group.
   * @return {number} The cumulative distribution value.
   */
  cume_dist: () => op('cume_dist'),

  /**
   * Window function to assign a quantile (e.g., percentile) value to each
   * value in a group. Accepts an integer parameter indicating the number of
   * buckets to use (e.g., 100 for percentiles, 5 for quintiles).
   * @param {number} num The number of buckets for ntile calculation.
   * @return {number} The quantile value.
   */
  ntile: (num) => op('ntile', null, num),

  /**
   * Window function to assign a value that precedes the current value by
   * a specified number of positions. If no such value exists, returns a
   * default value instead.
   * @param {*} field The data field.
   * @param {number} [offset=1] The lag offset from the current value.
   * @param {*} [defaultValue=undefined] The default value.
   * @return {*} The lagging value.
   */
  lag: (field, offset, defaultValue) => op('lag', field, [offset, defaultValue]),

  /**
   * Window function to assign a value that follows the current value by
   * a specified number of positions. If no such value exists, returns a
   * default value instead.
   * @param {*} field The data field.
   * @param {number} [offset=1] The lead offset from the current value.
   * @param {*} [defaultValue=undefined] The default value.
   * @return {*} The leading value.
   */
  lead: (field, offset, defaultValue) => op('lead', field, [offset, defaultValue]),

  /**
   * Window function to assign the first value in a sliding window frame.
   * @param {*} field The data field.
   * @return {*} The first value in the current frame.
   */
  first_value: (field) => op('first_value', field),

  /**
   * Window function to assign the last value in a sliding window frame.
   * @param {*} field The data field.
   * @return {*} The last value in the current frame.
   */
  last_value: (field) => op('last_value', field),

  /**
   * Window function to assign the nth value in a sliding window frame
   * (counting from 1), or undefined if no such value exists.
   * @param {*} field The data field.
   * @param {number} nth The nth position, starting from 1.
   * @return {*} The nth value in the current frame.
   */
  nth_value: (field, nth) => op('nth_value', field, nth),

  /**
   * Window function to fill in missing values with preceding values.
   * @param {*} field The data field.
   * @param {*} [defaultValue=undefined] The default value.
   * @return {*} The current value if valid, otherwise the first preceding
   *  valid value. If no such value exists, returns the default value.
   */
  fill_down: (field, defaultValue) => op('fill_down', field, defaultValue),

  /**
   * Window function to fill in missing values with subsequent values.
   * @param {*} field The data field.
   * @param {*} [defaultValue=undefined] The default value.
   * @return {*} The current value if valid, otherwise the first subsequent
   *  valid value. If no such value exists, returns the default value.
   */
  fill_up: (field, defaultValue) => op('fill_up', field, defaultValue)
};

function uniqueName(names, name) {
  names = isMapOrSet(names) ? names : new Set(names);
  let uname = name;
  let index = 0;

  while (names.has(uname)) {
    uname = name + ++index;
  }

  return uname;
}

/**
 * Regroup table rows in response to a BitSet filter.
 * @param {GroupBySpec} groups The current groupby specification.
 * @param {BitSet} filter The filter to apply.
 */
function regroup(groups, filter) {
  if (!groups || !filter) return groups;

  // check for presence of rows for each group
  const { keys, rows, size } = groups;
  const map = new Int32Array(size);
  filter.scan(row => map[keys[row]] = 1);

  // check sum, exit early if all groups occur
  const sum = map.reduce((sum, val) => sum + val, 0);
  if (sum === size) return groups;

  // create group index map, filter exemplar rows
  const _rows = Array(sum);
  let _size = 0;
  for (let i = 0; i < size; ++i) {
    if (map[i]) _rows[map[i] = _size++] = rows[i];
  }

  // re-index the group keys
  const _keys = new Uint32Array(keys.length);
  filter.scan(row => _keys[row] = map[keys[row]]);

  return { ...groups, keys: _keys, rows: _rows, size: _size };
}

/**
 * Regroup table rows in response to a re-indexing.
 * This operation may or may not involve filtering of rows.
 * @param {GroupBySpec} groups The current groupby specification.
 * @param {Function} scan Function to scan new row indices.
 * @param {boolean} filter Flag indicating if filtering may occur.
 * @param {number} nrows The number of rows in the new table.
 */
function reindex(groups, scan, filter, nrows) {
  const { keys, rows, size } = groups;
  let _rows = rows;
  let _size = size;
  let map = null;

  if (filter) {
    // check for presence of rows for each group
    map = new Int32Array(size);
    scan(row => map[keys[row]] = 1);

    // check sum, regroup if not all groups occur
    const sum = map.reduce((sum, val) => sum + val, 0);
    if (sum !== size) {
      // create group index map, filter exemplar rows
      _rows = Array(sum);
      _size = 0;
      for (let i = 0; i < size; ++i) {
        if (map[i]) _rows[map[i] = _size++] = rows[i];
      }
    }
  }

  // re-index the group keys
  let r = -1;
  const _keys = new Uint32Array(nrows);
  const fn = _size !== size
    ? row => _keys[++r] = map[keys[row]]
    : row => _keys[++r] = keys[row];
  scan(fn);

  return { ...groups, keys: _keys, rows: _rows, size: _size };
}

function nest(table, idx, obj, type) {
  const agg = type === 'map' || type === true ? map_agg
    : type === 'entries' ? entries_agg
    : type === 'object' ? object_agg
    : error('groups option must be "map", "entries", or "object".');

  const { names } = table.groups();
  const col = uniqueName(table.columnNames(), '_');

  // create table with one column of row objects
  // then aggregate into per-group arrays
  let t = table
    .select()
    .reify(idx)
    .create({ data: { [col]: obj } })
    .rollup({ [col]: array_agg(col) });

  // create nested structures for each level of grouping
  for (let i = names.length; --i >= 0;) {
    t = t
      .groupby(names.slice(0, i))
      .rollup({ [col]: agg(names[i], col) });
  }

  // return the final aggregated structure
  return t.get(col);
}

const ArrayPattern = 'ArrayPattern';
const ArrowFunctionExpression = 'ArrowFunctionExpression';
const FunctionExpression = 'FunctionExpression';
const Identifier = 'Identifier';
const Literal = 'Literal';
const MemberExpression = 'MemberExpression';
const ObjectExpression = 'ObjectExpression';
const ObjectPattern = 'ObjectPattern';
const Property = 'Property';

const Column = 'Column';
const Constant = 'Constant';
const Dictionary = 'Dictionary';
const Function$1 = 'Function';
const Parameter = 'Parameter';
const Op = 'Op';

const visit = (node, opt) => {
  const f = visitors$1[node.type];
  return f
    ? f(node, opt)
    : error(`Unsupported expression construct: ${node.type}`);
};

const binary$1 = (node, opt) => {
  return '(' + visit(node.left, opt) + ' ' + node.operator + ' ' + visit(node.right, opt) + ')';
};

const func$2 = (node, opt) => {
  return '(' + list$1(node.params, opt) + ')=>' + visit(node.body, opt);
};

const call$1 = (node, opt) => {
  return visit(node.callee, opt) + '(' + list$1(node.arguments, opt) + ')';
};

const list$1 = (array, opt, delim = ',') => {
  return array.map(node => visit(node, opt)).join(delim);
};

const name$1 = node => node.computed
  ? `[${toString(node.name)}]`
  : `.${node.name}`;

const ref = (node, opt, method) => {
  const table = node.table || '';
  return `data${table}${name$1(node)}.${method}(${opt.index}${table})`;
};

const visitors$1 = {
  Constant: node => node.raw,
  Column: (node, opt) => ref(node, opt, 'get'),
  Dictionary: (node, opt) => ref(node, opt, 'key'),
  Function: node => `fn.${node.name}`,
  Parameter: node => `$${name$1(node)}`,
  Op: (node, opt) => `op(${toString(node.name)},${opt.op || opt.index})`,
  Literal: node => node.raw,
  Identifier: node => node.name,
  TemplateLiteral: (node, opt) => {
    const { quasis, expressions } = node;
    const n = expressions.length;
    let t = quasis[0].value.raw;
    for (let i = 0; i < n;) {
      t += '${' + visit(expressions[i], opt) + '}' + quasis[++i].value.raw;
    }
    return '`' + t + '`';
  },
  MemberExpression: (node, opt) => {
    const d = !node.computed;
    const o = visit(node.object, opt);
    const p = visit(node.property, opt);
    return o + (d ? '.' + p : '[' + p + ']');
  },
  CallExpression: call$1,
  NewExpression: (node, opt) => {
    return 'new ' + call$1(node, opt);
  },
  ArrayExpression: (node, opt) => {
    return '[' + list$1(node.elements, opt) + ']';
  },
  AssignmentExpression: binary$1,
  BinaryExpression: binary$1,
  LogicalExpression: binary$1,
  UnaryExpression: (node, opt) => {
    return '(' + node.operator + visit(node.argument, opt) + ')';
  },
  ConditionalExpression: (node, opt) => {
    return '(' + visit(node.test, opt) +
      '?' + visit(node.consequent, opt) +
      ':' + visit(node.alternate, opt) + ')';
  },
  ObjectExpression: (node, opt) => {
    return '({' + list$1(node.properties, opt) + '})';
  },
  Property: (node, opt) => {
    const key = visit(node.key, opt);
    return (node.computed ? `[${key}]` : key) + ':' + visit(node.value, opt);
  },

  ArrowFunctionExpression: func$2,
  FunctionExpression: func$2,
  FunctionDeclaration: func$2,

  ArrayPattern: (node, opt) => {
    return '[' + list$1(node.elements, opt) + ']';
  },
  ObjectPattern: (node, opt) => {
    return '{' + list$1(node.properties, opt) + '}';
  },
  VariableDeclaration: (node, opt) => {
    return node.kind + ' ' + list$1(node.declarations, opt, ',');
  },
  VariableDeclarator: (node, opt) => {
    return visit(node.id, opt) + '=' + visit(node.init, opt);
  },
  SpreadElement: (node, opt) => {
    return '...' + visit(node.argument, opt);
  },

  BlockStatement: (node, opt) => {
    return '{' + list$1(node.body, opt, ';') + ';}';
  },
  BreakStatement: () => {
    return 'break';
  },
  ExpressionStatement: (node, opt) => {
    return visit(node.expression, opt);
  },
  IfStatement: (node, opt) => {
    return 'if (' + visit(node.test, opt) + ')'
      + visit(node.consequent, opt)
      + (node.alternate ? ' else ' + visit(node.alternate, opt) : '');
  },
  SwitchStatement: (node, opt) => {
    return 'switch (' + visit(node.discriminant, opt) + ') {'
     + list$1(node.cases, opt, '')
     + '}';
  },
  SwitchCase: (node, opt) => {
    return (node.test ? 'case ' + visit(node.test, opt) : 'default')
      + ': '
      + list$1(node.consequent, opt, ';') + ';';
  },
  ReturnStatement: (node, opt) => {
    return 'return ' + visit(node.argument, opt);
  },
  Program: (node, opt) => visit(node.body[0], opt)
};

function codegen(node, opt = { index: 'row' }) {
  return visit(node, opt);
}

function bins(min, max, maxbins = 15, nice = true, minstep = 0, step) {
  const base = 10;
  const logb = Math.LN10;

  if (step == null) {
    const level = Math.ceil(Math.log(maxbins) / logb);
    const span = (max - min) || Math.abs(min) || 1;
    const div = [5, 2];

    step = Math.max(
      minstep,
      Math.pow(base, Math.round(Math.log(span) / logb) - level)
    );

    // increase step size if too many bins
    while (Math.ceil(span / step) > maxbins) {
      step *= base;
    }

    // decrease step size if it stays within maxbins
    const n = div.length;
    for (let i = 0; i < n; ++i) {
      const v = step / div[i];
      if (v >= minstep && span / v <= maxbins) {
        step = v;
      }
    }
  }

  // snap to "nice" boundaries
  if (nice) {
    let v = Math.log(step);
    const precision = v >= 0 ? 0 : ~~(-v / logb) + 1;
    const eps = Math.pow(base, -precision - 1);
    v = Math.floor(min / step + eps) * step;
    min = min < v ? v - step : v;
    max = Math.ceil(max / step) * step;
  }

  return [
    min,
    max === min ? min + step : max,
    step
  ];
}

function key(value) {
  const type = typeof value;
  return type === 'string' ? `"${value}"`
    : type !== 'object' || !value ? value
    : isDate(value) ? +value
    : isArray(value) || isTypedArray(value) ? `[${value.map(key)}]`
    : isRegExp(value) ? value + ''
    : objectKey(value);
}

function objectKey(value) {
  let s = '{';
  let i = -1;
  for (const k in value) {
    if (++i > 0) s += ',';
    s += `"${k}":${key(value[k])}`;
  }
  s += '}';
  return s;
}

function keyFunction(get, nulls) {
  const n = get.length;
  return n === 1
    ? (row, data) => key(get[0](row, data))
    : (row, data) => {
        let s = '';
        for (let i = 0; i < n; ++i) {
          if (i > 0) s += '|';
          const v = get[i](row, data);
          if (nulls && (v == null || v !== v)) return null;
          s += key(v);
        }
        return s;
      };
}

function distinctMap() {
  const map = new Map();
  return {
    count() {
      return map.size;
    },
    values() {
      return Array.from(map.values(), _ => _.v);
    },
    increment(v) {
      const k = key(v);
      const e = map.get(k);
      e ? ++e.n : map.set(k, { v, n: 1 });
    },
    decrement(v) {
      const k = key(v);
      const e = map.get(k);
      e.n === 1 ? map.delete(k) : --e.n;
    },
    forEach(fn) {
      map.forEach(({ v, n }) => fn(v, n));
    }
  };
}

function noop() {}

function product(values, start = 0, stop = values.length) {
  let prod = values[start++];

  for (let i = start; i < stop; ++i) {
    prod *= values[i];
  }

  return prod;
}

/**
 * Initialize an aggregate operator.
 */
function initOp(op) {
  op.init = op.init || noop;
  op.add = op.add || noop;
  op.rem = op.rem || noop;
  return op;
}

function initProduct(s, value) {
  s.product_v = false;
  return s.product = value;
}

/**
 * Initialize an aggregate operator.
 * @callback AggregateInit
 * @param {object} state The aggregate state object.
 * @return {void}
 */

/**
 * Add a value to an aggregate operator.
 * @callback AggregateAdd
 * @param {object} state The aggregate state object.
 * @param {*} value The value to add.
 * @return {void}
 */

/**
 * Remove a value from an aggregate operator.
 * @callback AggregateRem
 * @param {object} state The aggregate state object.
 * @param {*} value The value to remove.
 * @return {void}
 */

/**
 * Retrive an output value from an aggregate operator.
 * @callback AggregateValue
 * @param {object} state The aggregate state object.
 * @return {*} The output value.
 */

/**
 * An operator instance for an aggregate function.
 * @typedef {object} AggregateOperator
 * @property {AggregateInit} init Initialize the operator.
 * @property {AggregateAdd} add Add a value to the operator state.
 * @property {AggregateRem} rem Remove a value from the operator state.
 * @property {AggregateValue} value Retrieve an output value.
 */

/**
 * Create a new aggregate operator instance.
 * @callback AggregateCreate
 * @param {...any} params The aggregate operator parameters.
 * @return {AggregateOperator} The instantiated aggregate operator.
 */

/**
 * An operator definition for an aggregate function.
 * @typedef {object} AggregateDef
 * @property {AggregateCreate} create Create a new operator instance.
 * @property {number[]} param Two-element array containing the
 *  counts of input fields and additional parameters.
 * @property {string[]} [req] Names of operators required by this one.
 * @property {string[]} [stream] Names of operators required by this one
 *  for streaming operations (value removes).
 */

/**
 * Aggregate operator definitions.
 */
var aggregateFunctions = {
  /** @type {AggregateDef} */
  count: {
    create: () => initOp({
      value: s => s.count
    }),
    param: []
  },

  /** @type {AggregateDef} */
  array_agg: {
    create: () => initOp({
      init: s => s.values = true,
      value: s => s.list.values(s.stream)
    }),
    param: [1]
  },

  /** @type {AggregateDef} */
  object_agg: {
    create: () => initOp({
      init:  s => s.values = true,
      value: s => Object.fromEntries(s.list.values())
    }),
    param: [2]
  },

  /** @type {AggregateDef} */
  map_agg: {
    create: () => initOp({
      init:  s => s.values = true,
      value: s => new Map(s.list.values())
    }),
    param: [2]
  },

  /** @type {AggregateDef} */
  entries_agg: {
    create: () => initOp({
      init:  s => s.values = true,
      value: s => s.list.values(s.stream)
    }),
    param: [2]
  },

  /** @type {AggregateDef} */
  any: {
    create: () => initOp({
      add: (s, v) => { if (s.any == null) s.any = v; },
      value: s => s.valid ? s.any : NULL
    }),
    param: [1]
  },

  /** @type {AggregateDef} */
  valid: {
    create: () => initOp({
      value: s => s.valid
    }),
    param: [1]
  },

  /** @type {AggregateDef} */
  invalid: {
    create: () => initOp({
      value: s => s.count - s.valid
    }),
    param: [1]
  },

  /** @type {AggregateDef} */
  distinct: {
    create: () => ({
      init: s => s.distinct = distinctMap(),
      value: s => s.distinct.count() + (s.valid === s.count ? 0 : 1),
      add: (s, v) => s.distinct.increment(v),
      rem: (s, v) => s.distinct.decrement(v)
    }),
    param: [1]
  },

  /** @type {AggregateDef} */
  array_agg_distinct: {
    create: () => initOp({
      value: s => s.distinct.values()
    }),
    param: [1],
    req: ['distinct']
  },

  /** @type {AggregateDef} */
  mode: {
    create: () => initOp({
      value: s => {
        let mode = NULL;
        let max = 0;
        s.distinct.forEach((value, count) => {
          if (count > max) {
            max = count;
            mode = value;
          }
        });
        return mode;
      }
    }),
    param: [1],
    req: ['distinct']
  },

  /** @type {AggregateDef} */
  sum: {
    create: () => ({
      init:  s => s.sum = 0,
      value: s => s.valid ? s.sum : NULL,
      add: (s, v) => isBigInt(v)
        ? (s.sum === 0 ? s.sum = v : s.sum += v)
        : s.sum += +v,
      rem: (s, v) => s.sum -= v
    }),
    param: [1]
  },

  /** @type {AggregateDef} */
  product: {
    create: () => ({
      init:  s => initProduct(s, 1),
      value: s => s.valid
        ? (
            s.product_v
              ? initProduct(s, product(s.list.values()))
              : s.product
          )
        : undefined,
      add: (s, v) => isBigInt(v)
        ? (s.product === 1 ? s.product = v : s.product *= v)
        : s.product *= v,
      rem: (s, v) => (v == 0 || v === Infinity || v === -Infinity)
        ? s.product_v = true
        : s.product /= v
    }),
    param: [1],
    stream: ['array_agg']
  },

  /** @type {AggregateDef} */
  mean: {
    create: () => ({
      init: s => s.mean = 0,
      value: s => s.valid ? s.mean : NULL,
      add: (s, v) => {
        s.mean_d = v - s.mean;
        s.mean += s.mean_d / s.valid;
      },
      rem: (s, v) => {
        s.mean_d = v - s.mean;
        s.mean -= s.valid ? s.mean_d / s.valid : s.mean;
      }
    }),
    param: [1]
  },

  /** @type {AggregateDef} */
  average: {
    create: () => initOp({
      value: s => s.valid ? s.mean : NULL
    }),
    param: [1],
    req: ['mean']
  },

  /** @type {AggregateDef} */
  variance: {
    create: () => ({
      init:  s => s.dev = 0,
      value: s => s.valid > 1 ? s.dev / (s.valid - 1) : NULL,
      add: (s, v) => s.dev += s.mean_d * (v - s.mean),
      rem: (s, v) => s.dev -= s.mean_d * (v - s.mean)
    }),
    param: [1],
    req: ['mean']
  },

  /** @type {AggregateDef} */
  variancep: {
    create: () => initOp({
      value: s => s.valid > 1 ? s.dev / s.valid : NULL
    }),
    param: [1],
    req: ['variance']
  },

  /** @type {AggregateDef} */
  stdev: {
    create: () => initOp({
      value: s => s.valid > 1 ? Math.sqrt(s.dev / (s.valid - 1)) : NULL
    }),
    param: [1],
    req: ['variance']
  },

  /** @type {AggregateDef} */
  stdevp: {
    create: () => initOp({
      value: s => s.valid > 1 ? Math.sqrt(s.dev / s.valid) : NULL
    }),
    param: [1],
    req: ['variance']
  },

  /** @type {AggregateDef} */
  min: {
    create: () => ({
      init:  s => s.min = NULL,
      value: s => s.min = (Number.isNaN(s.min) ? s.list.min() : s.min),
      add: (s, v) => { if (v < s.min || s.min === NULL) s.min = v; },
      rem: (s, v) => { if (v <= s.min) s.min = NaN; }
    }),
    param: [1],
    stream: ['array_agg']
  },

  /** @type {AggregateDef} */
  max: {
    create: () => ({
      init:  s => s.max = NULL,
      value: s => s.max = (Number.isNaN(s.max) ? s.list.max() : s.max),
      add: (s, v) => { if (v > s.max || s.max === NULL) s.max = v; },
      rem: (s, v) => { if (v >= s.max) s.max = NaN; }
    }),
    param: [1],
    stream: ['array_agg']
  },

  /** @type {AggregateDef} */
  quantile: {
    create: (p) => initOp({
      value: s => s.list.quantile(p)
    }),
    param: [1, 1],
    req: ['array_agg']
  },

  /** @type {AggregateDef} */
  median: {
    create: () => initOp({
      value: s => s.list.quantile(0.5)
    }),
    param: [1],
    req: ['array_agg']
  },

  /** @type {AggregateDef} */
  covariance: {
    create: () => ({
      init:  s => {
        s.cov = s.mean_x = s.mean_y = s.dev_x = s.dev_y = 0;
      },
      value: s => s.valid > 1 ? s.cov / (s.valid - 1) : NULL,
      add: (s, x, y) => {
        const dx = x - s.mean_x;
        const dy = y - s.mean_y;
        s.mean_x += dx / s.valid;
        s.mean_y += dy / s.valid;
        const dy2 = y - s.mean_y;
        s.dev_x += dx * (x - s.mean_x);
        s.dev_y += dy * dy2;
        s.cov += dx * dy2;
      },
      rem: (s, x, y) => {
        const dx = x - s.mean_x;
        const dy = y - s.mean_y;
        s.mean_x -= s.valid ? dx / s.valid : s.mean_x;
        s.mean_y -= s.valid ? dy / s.valid : s.mean_y;
        const dy2 = y - s.mean_y;
        s.dev_x -= dx * (x - s.mean_x);
        s.dev_y -= dy * dy2;
        s.cov -= dx * dy2;
      }
    }),
    param: [2]
  },

  /** @type {AggregateDef} */
  covariancep: {
    create: () => initOp({
      value: s => s.valid > 1 ? s.cov / s.valid : NULL
    }),
    param: [2],
    req: ['covariance']
  },

  /** @type {AggregateDef} */
  corr: {
    create: () => initOp({
      value: s => s.valid > 1
        ? s.cov / (Math.sqrt(s.dev_x) * Math.sqrt(s.dev_y))
        : NULL
    }),
    param: [2],
    req: ['covariance']
  },

  /** @type {AggregateDef} */
  bins: {
    create: (maxbins, nice, minstep, step) => initOp({
      value: s => bins(s.min, s.max, maxbins, nice, minstep, step)
    }),
    param: [1, 4],
    req: ['min', 'max']
  }
};

/**
 * Initialize a window operator.
 * @callback WindowInit
 * @return {void}
 */

/**
 * Retrieve an output value from a window operator.
 * @callback WindowValue
 * @param {WindowState} state The window state object.
 * @return {*} The output value.
 */

/**
 * An operator instance for a window function.
 * @typedef {object} WindowOperator
 * @property {AggregateInit} init Initialize the operator.
 * @property {AggregateValue} value Retrieve an output value.
 */

/**
 * Create a new window operator instance.
 * @callback WindowCreate
 * @param {...any} params The aggregate operator parameters.
 * @return {WindowOperator} The instantiated window operator.
 */

/**
 * An operator definition for a window function.
 * @typedef {object} WindowDef
 * @property {AggregateCreate} create Create a new operator instance.
 * @property {number[]} param Two-element array containing the
 *  counts of input fields and additional parameters.
 */

const rank = {
  create() {
    let rank;
    return {
      init: () => rank = 1,
      value: w => {
        const i = w.index;
        return (i && !w.peer(i)) ? (rank = i + 1) : rank;
      }
    };
  },
  param: []
};

const cume_dist = {
  create() {
    let cume;
    return {
      init: () => cume = 0,
      value: w => {
        const { index, peer, size } = w;
        let i = index;
        if (cume < i) {
          while (i + 1 < size && peer(i + 1)) ++i;
          cume = i;
        }
        return (1 + cume) / size;
      }
    };
  },
  param: []
};

/**
 * Window operator definitions.
 */
var windowFunctions = {
  /** @type {WindowDef} */
  row_number: {
    create() {
      return {
        init: noop,
        value: w => w.index + 1
      };
    },
    param: []
  },

  /** @type {WindowDef} */
  rank,

  /** @type {WindowDef} */
  avg_rank: {
    create() {
      let j, rank;
      return {
        init: () => (j = -1, rank = 1),
        value: w => {
          const i = w.index;
          if (i >= j) {
            for (rank = j = i + 1; w.peer(j); rank += ++j);
            rank /= (j - i);
          }
          return rank;
        }
      };
    },
    param: []
  },

  /** @type {WindowDef} */
  dense_rank: {
    create() {
      let drank;
      return {
        init: () => drank = 1,
        value: w => {
          const i = w.index;
          return (i && !w.peer(i)) ? ++drank : drank;
        }
      };
    },
    param: []
  },

  /** @type {WindowDef} */
  percent_rank: {
    create() {
      const { init, value } = rank.create();
      return {
        init,
        value: w => (value(w) - 1) / (w.size - 1)
      };
    },
    param: []
  },

  /** @type {WindowDef} */
  cume_dist,

  /** @type {WindowDef} */
  ntile: {
    create(num) {
      num = +num;
      if (!(num > 0)) error('ntile num must be greater than zero.');
      const { init, value } = cume_dist.create();
      return {
        init,
        value: w => Math.ceil(num * value(w))
      };
    },
    param: [0, 1]
  },

  /** @type {WindowDef} */
  lag: {
    create(offset, defaultValue = NULL) {
      offset = +offset || 1;
      return {
        init: noop,
        value: (w, f) => {
          const i = w.index - offset;
          return i >= 0 ? w.value(i, f) : defaultValue;
        }
      };
    },
    param: [1, 2]
  },

  /** @type {WindowDef} */
  lead: {
    create(offset, defaultValue = NULL) {
      offset = +offset || 1;
      return {
        init: noop,
        value: (w, f) => {
          const i = w.index + offset;
          return i < w.size ? w.value(i, f) : defaultValue;
        }
      };
    },
    param: [1, 2]
  },

  /** @type {WindowDef} */
  first_value: {
    create() {
      return {
        init: noop,
        value: (w, f) => w.value(w.i0, f)
      };
    },
    param: [1]
  },

  /** @type {WindowDef} */
  last_value: {
    create() {
      return {
        init: noop,
        value: (w, f) => w.value(w.i1 - 1, f)
      };
    },
    param: [1]
  },

  /** @type {WindowDef} */
  nth_value: {
    create(nth) {
      nth = +nth;
      if (!(nth > 0)) error('nth_value nth must be greater than zero.');
      return {
        init: noop,
        value: (w, f) => {
          const i = w.i0 + (nth - 1);
          return i < w.i1 ? w.value(i, f) : NULL;
        }
      };
    },
    param: [1, 1]
  },

  /** @type {WindowDef} */
  fill_down: {
    create(defaultValue = NULL) {
      let value;
      return {
        init: () => value = defaultValue,
        value: (w, f) => {
          const v = w.value(w.index, f);
          return isValid(v) ? (value = v) : value;
        }
      };
    },
    param: [1, 1]
  },

  /** @type {WindowDef} */
  fill_up: {
    create(defaultValue = NULL) {
      let value, idx;
      return {
        init: () => (value = defaultValue, idx = -1),
        value: (w, f) => w.index <= idx ? value
          : (idx = find(w, f, w.index)) >= 0 ? (value = w.value(idx, f))
          : (idx = w.size, value = defaultValue)
      };
    },
    param: [1, 1]
  }
};

function find(w, f, i) {
  for (const n = w.size; i < n; ++i) {
    if (isValid(w.value(i, f))) return i;
  }
  return -1;
}

/**
 * Check if an aggregate function with the given name exists.
 * @param {string} name The name of the aggregate function.
 * @return {boolean} True if found, false otherwise.
 */
function hasAggregate(name) {
  return has(aggregateFunctions, name);
}

/**
 * Check if a window function with the given name exists.
 * @param {string} name The name of the window function.
 * @return {boolean} True if found, false otherwise.
 */
function hasWindow(name) {
  return has(windowFunctions, name);
}

/**
 * Check if an expression function with the given name exists.
 * @param {string} name The name of the function.
 * @return {boolean} True if found, false otherwise.
 */
 function hasFunction(name) {
  return has(functions, name) || name === 'row_object';
}

/**
 * Get an aggregate function definition.
 * @param {string} name The name of the aggregate function.
 * @return {AggregateDef} The aggregate function definition,
 *  or undefined if not found.
 */
function getAggregate(name) {
  return hasAggregate(name) && aggregateFunctions[name];
}

/**
 * Get a window function definition.
 * @param {string} name The name of the window function.
 * @return {WindowDef} The window function definition,
 *  or undefined if not found.
 */
function getWindow(name) {
  return hasWindow(name) && windowFunctions[name];
}

function compile(code, fn, params) {
  code = `"use strict"; return ${code};`;
  return (Function('fn', '$', code))(fn, params);
}

var compile$1 = {
  escape: (code, func, params) => compile(code, func, params),
  expr:   (code, params) => compile(`(row,data,op)=>${code}`, functions, params),
  expr2:  (code, params) => compile(`(row0,data0,row,data)=>${code}`, functions, params),
  join:   (code, params) => compile(`(row1,data1,row2,data2)=>${code}`, functions, params),
  param:  (code, params) => compile(code, functions, params)
};

const dictOps = {
  '==': 1,
  '!=': 1,
  '===': 1,
  '!==': 1
};

/**
 * Rewrite AST node to be a table column reference.
 * Additionally optimizes dictionary column operations.
 * @param {object} ref AST node to rewrite to a column reference.
 * @param {string} name The name of the column.
 * @param {number} index The table index of the column.
 * @param {object} col The actual table column instance.
 * @param {object} op Parent AST node operating on the column reference.
 */
function rewrite(ref, name, index = 0, col, op) {
  ref.type = Column;
  ref.name = name;
  ref.table = index;

  // proceed only if has parent op and is a dictionary column
  if (op && col && isFunction(col.keyFor)) {
    // get other arg if op is an optimizeable operation
    const lit = dictOps[op.operator]
      ? op.left === ref ? op.right : op.left
      : op.callee && op.callee.name === 'equal'
      ? op.arguments[op.arguments[0] === ref ? 1 : 0]
      : null;

    // rewrite as dictionary lookup if other arg is a literal
    if (lit && lit.type === Literal) {
      rewriteDictionary(op, ref, lit, col.keyFor(lit.value));
    }
  }

  return ref;
}

function rewriteDictionary(op, ref, lit, key) {
  if (key < 0) {
    // value not in dictionary, rewrite op as false literal
    op.type = Literal;
    op.value = false;
    op.raw = 'false';
  } else {
    // rewrite ref as dict key access
    ref.type = Dictionary;

    // rewrite literal as target dict key
    lit.value = key;
    lit.raw = key + '';
  }

  return true;
}

function entries(value) {
  return isArray(value) ? value
    : isMap(value) ? value.entries()
    : value ? Object.entries(value)
    : [];
}

const ROW_OBJECT = 'row_object';

function rowObjectExpression(node, props) {
  node.type = ObjectExpression;

  const p = node.properties = [];
  for (const prop of entries(props)) {
    const [name, key] = isArray(prop) ? prop : [prop, prop];
    p.push({
      type: Property,
      key: { type: Literal, raw: toString(key) },
      value: rewrite({ computed: true }, name)
    });
  }

  return node;
}

function rowObjectCode(props) {
  return codegen(rowObjectExpression({}, props));
}

function rowObjectBuilder(props) {
  return compile$1.expr(rowObjectCode(props));
}

function ceil64Bytes(length, bpe = 1) {
  return ((((length * bpe) + 63) & ~63) || 64) / bpe;
}

function array(Type, length, bpe = Type.BYTES_PER_ELEMENT) {
  return new Type(ceil64Bytes(length, bpe));
}

function arrowData(d) {
  return d instanceof apacheArrow.Data
    ? d
    : new apacheArrow.Data(d.type, 0, d.length, d.nulls, d.buffers, null, d.dict);
}

function arrowVector$1(data) {
  return new apacheArrow.Vector([arrowData(data)]);
}

const encoder = new TextEncoder();

function encode(data, idx, str) {
  const bytes = encoder.encode(str);
  data.set(bytes, idx);
  return bytes.length;
}

function encodeInto(data, idx, str) {
  return encoder.encodeInto(str, data.subarray(idx)).written;
}

const writeUtf8 = encoder.encodeInto ? encodeInto : encode;

function arrayBuilder(type, length) {
  const data = array(type.ArrayType, length);
  return {
    set(value, index) { data[index] = value; },
    data: () => ({ type, length, buffers: [null, data] })
  };
}

function boolBuilder(type, length) {
  const data = array(type.ArrayType, length / 8);
  return {
    set(value, index) {
      if (value) data[index >> 3] |= (1 << (index % 8));
    },
    data: () => ({ type, length, buffers: [null, data] })
  };
}

function dateDayBuilder(type, length) {
  const data = array(type.ArrayType, length);
  return {
    set(value, index) { data[index] = (value / 86400000) | 0; },
    data: () => ({ type, length, buffers: [null, data] })
  };
}

function dateMillisBuilder(type, length) {
  const data = array(type.ArrayType, length << 1);
  return {
    set(value, index) {
      const i = index << 1;
      data[  i] = (value % 4294967296) | 0;
      data[i+1] = (value / 4294967296) | 0;
    },
    data: () => ({ type, length, buffers: [null, data] })
  };
}

function defaultBuilder(type) {
  const b = apacheArrow.makeBuilder({
    type,
    nullValues: [null, undefined]
  });
  return {
    set(value, index) { b.set(index, value); },
    data: () => b.finish().flush()
  };
}

function utf8Builder(type, length, strlen) {
  const offset = array(Int32Array, length + 1);
  const buf = array(Uint8Array, 3 * strlen);

  let idx = 0;

  return {
    set(value, index) {
      idx += writeUtf8(buf, idx, value);
      offset[index + 1] = idx;
    },
    data: () => {
      // slice utf buffer if over-allocated
      const dlen = ceil64Bytes(idx);
      const data = buf.length > dlen ? buf.subarray(0, dlen) : buf;
      return { type, length, buffers: [offset, data] };
    }
  };
}

function dictionaryBuilder(type, length) {
  const values = [];
  const data = array(type.indices.ArrayType, length);
  const keys = Object.create(null);

  let next = -1;
  let strlen = 0;

  return {
    set(value, index) {
      const v = String(value);
      let k = keys[v];
      if (k === undefined) {
        strlen += v.length;
        keys[v] = k = ++next;
        values.push(v);
      }
      data[index] = k;
    },
    data: () => ({
      type,
      length,
      buffers: [null, data],
      dict: dictionary(type.dictionary, values, strlen)
    })
  };
}

function dictionary(type, values, strlen) {
  const b = utf8Builder(type, values.length, strlen);
  values.forEach(b.set);
  return arrowVector$1(b.data());
}

function validBuilder(builder, length) {
  const valid = array(Uint8Array, length / 8);
  let nulls = 0;

  return {
    set(value, index) {
      if (value == null) {
        ++nulls;
      } else {
        builder.set(value, index);
        valid[index >> 3] |= (1 << (index % 8));
      }
    },
    data: () => {
      const d = builder.data();
      if (nulls) {
        d.nulls = nulls;
        d.buffers[2] = valid;
      }
      return d;
    }
  };
}

function builder(type, nrows, nullable = true) {
  let method;

  switch (type.typeId) {
    case apacheArrow.Type.Int:
      method = type.bitWidth < 64 ? arrayBuilder : null;
      break;
    case apacheArrow.Type.Float:
      method = type.precision > 0 ? arrayBuilder : null;
      break;
    case apacheArrow.Type.Dictionary:
      // check sub-types against builder assumptions
      // if check fails, fallback to default builder
      method = (
        type.dictionary.typeId === apacheArrow.Type.Utf8 &&
        type.indices.typeId === apacheArrow.Type.Int &&
        type.indices.bitWidth < 64
      ) ? dictionaryBuilder : null;
      break;
    case apacheArrow.Type.Bool:
      method = boolBuilder;
      break;
    case apacheArrow.Type.Date:
      method = type.unit ? dateMillisBuilder : dateDayBuilder;
      break;
  }

  return method == null ? defaultBuilder(type)
    : nullable ? validBuilder(method(type, nrows), nrows)
    : method(type, nrows);
}

function dataFromArray(array, type) {
  const length = array.length;
  const size = ceil64Bytes(length, array.BYTES_PER_ELEMENT);

  let data = array;
  if (length !== size) {
    data = new array.constructor(size);
    data.set(array);
  }

  return arrowData({ type, length, buffers: [null, data] });
}

function dataFromScan(nrows, scan, column, type, nullable = true) {
  const b = builder(type, nrows, nullable);
  scan(column, b.set);
  return arrowData(b.data());
}

function resolveType(type) {
  if (type instanceof apacheArrow.DataType || type == null) {
    return type;
  }

  switch (type) {
    case apacheArrow.Type.Binary:
      return new apacheArrow.Binary();
    case apacheArrow.Type.Bool:
      return new apacheArrow.Bool();
    case apacheArrow.Type.DateDay:
      return new apacheArrow.DateDay();
    case apacheArrow.Type.DateMillisecond:
    case apacheArrow.Type.Date:
      return new apacheArrow.DateMillisecond();
    case apacheArrow.Type.Dictionary:
      return new apacheArrow.Dictionary(new apacheArrow.Utf8(), new apacheArrow.Int32());
    case apacheArrow.Type.Float16:
      return new apacheArrow.Float16();
    case apacheArrow.Type.Float32:
      return new apacheArrow.Float32();
    case apacheArrow.Type.Float64:
    case apacheArrow.Type.Float:
      return new apacheArrow.Float64();
    case apacheArrow.Type.Int8:
      return new apacheArrow.Int8();
    case apacheArrow.Type.Int16:
      return new apacheArrow.Int16();
    case apacheArrow.Type.Int32:
    case apacheArrow.Type.Int:
      return new apacheArrow.Int32();
    case apacheArrow.Type.Int64:
      return new apacheArrow.Int64();
    case apacheArrow.Type.IntervalDayTime:
      return new apacheArrow.IntervalDayTime();
    case apacheArrow.Type.Interval:
    case apacheArrow.Type.IntervalYearMonth:
      return new apacheArrow.IntervalYearMonth();
    case apacheArrow.Type.Null:
      return new apacheArrow.Null();
    case apacheArrow.Type.TimeMicrosecond:
      return new apacheArrow.TimeMicrosecond();
    case apacheArrow.Type.TimeMillisecond:
    case apacheArrow.Type.Time:
      return new apacheArrow.TimeMillisecond();
    case apacheArrow.Type.TimeNanosecond:
      return new apacheArrow.TimeNanosecond();
    case apacheArrow.Type.TimeSecond:
      return new apacheArrow.TimeSecond();
    case apacheArrow.Type.Uint8:
      return new apacheArrow.Uint8();
    case apacheArrow.Type.Uint16:
      return new apacheArrow.Uint16();
    case apacheArrow.Type.Uint32:
      return new apacheArrow.Uint32();
    case apacheArrow.Type.Uint64:
      return new apacheArrow.Uint64();
    case apacheArrow.Type.Utf8:
      return new apacheArrow.Utf8();
    default:
      error(
        `Unsupported type code: ${toString(type)}. ` +
        'Use a data type constructor instead?'
      );
  }
}

function isExactUTCDate(d) {
  return d.getUTCHours() === 0
    && d.getUTCMinutes() === 0
    && d.getUTCSeconds() === 0
    && d.getUTCMilliseconds() === 0;
}

function profile(scan, column) {
  const p = profiler();
  scan(column, p.add);
  return p;
}

function profiler() {
  const p = {
    count: 0,
    nulls: 0,
    bools: 0,
    nums: 0,
    ints: 0,
    bigints: 0,
    min: Infinity,
    max: -Infinity,
    digits: 0,
    dates: 0,
    utcdays: 0,
    strings: 0,
    strlen: 0,
    arrays: 0,
    minlen: Infinity,
    maxlen: 0,
    structs: 0,

    add(value) {
      ++p.count;
      if (value == null) {
        ++p.nulls;
        return;
      }

      const type = typeof value;
      if (type === 'string') {
        ++p.strings;
      } else if (type === 'number') {
        ++p.nums;
        if (value < p.min) p.min = value;
        if (value > p.max) p.max = value;
        if (Number.isInteger(value)) ++p.ints;
      } else if (type === 'boolean') {
        ++p.bools;
      } else if (type === 'object') {
        if (isDate(value)) {
          ++p.dates;
          if (isExactUTCDate(value)) {
            ++p.utcdays;
          }
        } else if (isArrayType(value)) {
          ++p.arrays;
          if (value.length < p.minlen) p.minlen = value.length;
          if (value.length > p.maxlen) p.maxlen = value.length;
          const ap = p.array_prof || (p.array_prof = profiler());
          value.forEach(ap.add);
        } else {
          ++p.structs;
          const sp = p.struct_prof || (p.struct_prof = {});
          for (const key in value) {
            const fp = sp[key] || (sp[key] = profiler());
            fp.add(value[key]);
          }
        }
      } else if (type === 'bigint') {
        ++p.bigints;
        if (value < p.min) p.min = value;
        if (value > p.max) p.max = value;
      }
    },
    type() {
      return resolveType(infer(p));
    }
  };

  return p;
}

function infer(p) {
  const valid = p.count - p.nulls;

  if (valid === 0) {
    return apacheArrow.Type.Null;
  }
  else if (p.ints === valid) {
    const v = Math.max(Math.abs(p.min) - 1, p.max);
    return p.min < 0
      ? v >= 2 ** 31 ? apacheArrow.Type.Float64
        : v < (1 << 7) ? apacheArrow.Type.Int8 : v < (1 << 15) ? apacheArrow.Type.Int16 : apacheArrow.Type.Int32
      : v >= 2 ** 32 ? apacheArrow.Type.Float64
        : v < (1 << 8) ? apacheArrow.Type.Uint8 : v < (1 << 16) ? apacheArrow.Type.Uint16 : apacheArrow.Type.Uint32;
  }
  else if (p.nums === valid) {
    return apacheArrow.Type.Float64;
  }
  else if (p.bigints === valid) {
    const v = -p.min > p.max ? -p.min - 1n : p.max;
    return p.min < 0
      ? v < 2 ** 63 ? apacheArrow.Type.Int64
        : error(`BigInt exceeds 64 bits: ${v}`)
      : p.max < 2 ** 64 ? apacheArrow.Type.Uint64
        : error(`BigInt exceeds 64 bits: ${p.max}`);
  }
  else if (p.bools === valid) {
    return apacheArrow.Type.Bool;
  }
  else if (p.utcdays === valid) {
    return apacheArrow.Type.DateDay;
  }
  else if (p.dates === valid) {
    return apacheArrow.Type.DateMillisecond;
  }
  else if (p.arrays === valid) {
    const type = apacheArrow.Field.new('value', p.array_prof.type(), true);
    return p.minlen === p.maxlen
      ? new apacheArrow.FixedSizeList(p.minlen, type)
      : new apacheArrow.List(type);
  }
  else if (p.structs === valid) {
    const sp = p.struct_prof;
    return new apacheArrow.Struct(
      Object.keys(sp).map(name => apacheArrow.Field.new(name, sp[name].type(), true))
    );
  }
  else if (p.strings > 0) {
    return apacheArrow.Type.Dictionary;
  }
  else {
    error('Type inference failure');
  }
}

function dataFromObjects(data, name, nrows, scan, type, nullable = true) {
  type = resolveType(type);

  // perform type inference if needed
  if (!type) {
    const p = profile(scan, name);
    nullable = p.nulls > 0;
    type = p.type();
  }

  return dataFromScan(nrows, scan, name, type, nullable);
}

function dataFromTable(table, name, nrows, scan, type, nullable = true) {
  type = resolveType(type);
  const column = table.column(name);
  const reified = !(table.isFiltered() || table.isOrdered());

  // use existing arrow data if types match
  const vec = arrowVector(column);
  if (vec && reified && typeCompatible(vec.type, type)) {
    return vec;
  }

  // if backing data is a typed array, leverage that
  const data = column.data;
  if (isTypedArray(data)) {
    const dtype = typeFromArray(data);
    if (reified && dtype && typeCompatible(dtype, type)) {
      return dataFromArray(data, dtype);
    } else {
      type = type || dtype;
      nullable = false;
    }
  }

  // perform type inference if needed
  if (!type) {
    const p = profile(scan, column);
    nullable = p.nulls > 0;
    type = p.type();
  }

  return dataFromScan(nrows, scan, column, type, nullable);
}

function arrowVector(value) {
  return value instanceof apacheArrow.Vector ? value
    : value.vector instanceof apacheArrow.Vector ? value.vector
    : null;
}

function typeFromArray(data) {
  const types = {
    Float32Array:    apacheArrow.Float32,
    Float64Array:    apacheArrow.Float64,
    Int8Array:       apacheArrow.Int8,
    Int16Array:      apacheArrow.Int16,
    Int32Array:      apacheArrow.Int32,
    Uint8Array:      apacheArrow.Uint8,
    Uint16Array:     apacheArrow.Uint16,
    Uint32Array:     apacheArrow.Uint32,
    BigInt64Array:   apacheArrow.Int64,
    BigUint64Array:  apacheArrow.Uint64
  };
  const Type = types[data.constructor.name];
  return Type ? new Type() : null;
}

function typeCompatible(a, b) {
  return !a || !b ? true : a.compareTo(b);
}

function scanArray(data, limit, offset) {
  const n = Math.min(data.length, offset + limit);
  return (name, visit) => {
    for (let i = offset; i < n; ++i) {
      visit(data[i][name], i);
    }
  };
}

function scanTable(table, limit, offset) {
  const scanAll = offset === 0 && table.numRows() <= limit
               && !table.isFiltered() && !table.isOrdered();

  return (column, visit) => {
    let i = -1;
    scanAll && isArrayType(column.data)
      ? column.data.forEach(visit)
      : table.scan(
          row => visit(column.get(row), ++i),
          true, limit, offset
        );
  };
}

const fail = () => error(
  'Apache Arrow not imported, ' +
  'see https://github.com/uwdata/arquero#usage'
);

function table$1() {
  // trap access to provide a helpful message
  // when Apache Arrow has not been imported
  try {
    return apacheArrow.Table;
  } catch (err) {
    fail();
  }
}

function fromIPC() {
  // trap access to provide a helpful message
  // when Apache Arrow has not been imported
  try {
    return apacheArrow.tableFromIPC;
  } catch (err) {
    fail();
  }
}

/**
 * Options for Arrow encoding.
 * @typedef {object} ArrowFormatOptions
 * @property {number} [limit=Infinity] The maximum number of rows to include.
 * @property {number} [offset=0] The row offset indicating how many initial
 *  rows to skip.
 * @property {string[]|(data: object) => string[]} [columns] Ordered list of
 *  column names to include. If function-valued, the function should accept
 *  a dataset as input and return an array of column name strings.
 * @property {object} [types] The Arrow data types to use. If specified,
 *  the input should be an object with column names for keys and Arrow data
 *  types for values. If a column type is not explicitly provided, type
 *  inference will be performed to guess an appropriate type.
 */

/**
 * Create an Apache Arrow table for an input dataset.
 * @param {Array|object} data An input dataset to convert to Arrow format.
 *  If array-valued, the data should consist of an array of objects where
 *  each entry represents a row and named properties represent columns.
 *  Otherwise, the input data should be an Arquero table.
 * @param {ArrowFormatOptions} [options] Encoding options, including
 *  column data types.
 * @return {Table} An Apache Arrow Table instance.
 */
function toArrow(data, options = {}) {
  const { types = {} } = options;
  const { dataFrom, names, nrows, scan } = init(data, options);
  const cols = {};
  names.forEach(name => {
    const col = dataFrom(data, name, nrows, scan, types[name]);
    if (col.length !== nrows) {
      error('Column length mismatch');
    }
    cols[name] = col;
  });
  const T = table$1();
  return new T(cols);
}

function init(data, options) {
  const { columns, limit = Infinity, offset = 0 } = options;
  const names = isFunction(columns) ? columns(data)
    : isArray(columns) ? columns
    : null;
  if (isArray(data)) {
    return {
      dataFrom: dataFromObjects,
      names: names || Object.keys(data[0]),
      nrows: Math.min(limit, data.length - offset),
      scan: scanArray(data, limit, offset)
    };
  } else if (isTable(data)) {
    return {
      dataFrom: dataFromTable,
      names: names || data.columnNames(),
      nrows: Math.min(limit, data.numRows() - offset),
      scan: scanTable(data, limit, offset)
    };
  } else {
    error('Unsupported input data type');
  }
}

function isTable(data) {
  return data && isFunction(data.reify);
}

function toArrowIPC(table, options = {}) {
  const { format: format, ...toArrowOptions } = options;
  const outputFormat = format ? format : 'stream';
  if (!['stream', 'file'].includes(outputFormat)) {
    throw Error('Unrecognised output format');
  }
  return apacheArrow.tableToIPC(toArrow(table, toArrowOptions), format);
}

function isExactDateUTC(d) {
  return d.getUTCHours() === 0
    && d.getUTCMinutes() === 0
    && d.getUTCSeconds() === 0
    && d.getUTCMilliseconds() === 0;
}

function inferFormat(scan, options = {}) {
  let count = 0;
  let nulls = 0;
  let dates = 0;
  let dutcs = 0;
  let nums = 0;
  let digits = 0;

  scan(value => {
    ++count;
    if (value == null) {
      ++nulls;
      return;
    }

    const type = typeof value;
    if (type === 'object' && isDate(value)) {
      ++dates;
      if (isExactDateUTC(value)) ++dutcs;
    } else if (type === 'number') {
      ++nums;
      if (value === value &&  (value | 0) !== value) {
        const s = value + '';
        const p = s.indexOf('.');
        if (p >= 0) {
          const e = s.indexOf('e');
          const l = e > 0 ? e : s.length;
          digits = Math.max(digits, l - p - 1);
        }
      }
    }
  });

  return {
    align:  (nulls + nums + dates) / count > 0.5 ? 'r' : 'l',
    format: {
      utc:    dates === dutcs,
      digits: Math.min(digits, options.maxdigits || 6)
    }
  };
}

/**
 * Column selection function.
 * @typedef {(table: Table) => string[]} ColumnSelectFunction
 */

/**
 * Column selection options.
 * @typedef {string[]|ColumnSelectFunction} ColumnSelectOptions
 */

/**
 * Column format options. The object keys should be column names.
 * The object values should be formatting functions or objects.
 * If specified, these override any automatically inferred options.
 * @typedef {Object.<string, import('./value').ValueFormatOptions} ColumnFormatOptions
 */

/**
 * Column alignment options. The object keys should be column names.
 * The object values should be aligment strings, one of 'l' (left),
 * 'c' (center), or 'r' (right).
 * If specified, these override any automatically inferred options.
 * @typedef {Object.<string, 'l'|'c'|'r'>} ColumnAlignOptions
 */

function columns(table, names) {
  return isFunction(names)
    ? names(table)
    : names || table.columnNames();
}

function formats(table, names, options) {
  const formatOpt = options.format || {};
  const alignOpt = options.align || {};
  const format = {};
  const align = {};

  names.forEach(name => {
    const auto = inferFormat(values(table, name), options);
    align[name] = alignOpt[name] || auto.align;
    format[name] = formatOpt[name] || auto.format;
  });

  return { align, format };
}

function values(table, columnName) {
  const column = table.column(columnName);
  return fn => table.scan(row => fn(column.get(row)));
}

function scan(table, names, limit = 100, offset, ctx) {
  const data = table.data();
  const n = names.length;
  table.scan(row => {
    ctx.row(row);
    for (let i = 0; i < n; ++i) {
      const name = names[i];
      ctx.cell(data[names[i]].get(row), name, i);
    }
  }, true, limit, offset);
}

/**
 * Options for CSV formatting.
 * @typedef {object} CSVFormatOptions
 * @property {string} [delimiter=','] The delimiter between values.
 * @property {number} [limit=Infinity] The maximum number of rows to print.
 * @property {number} [offset=0] The row offset indicating how many initial rows to skip.
 * @property {import('./util').ColumnSelectOptions} [columns] Ordered list
 *  of column names to include. If function-valued, the function should
 *  accept a table as input and return an array of column name strings.
 * @property {Object.<string, (value: any) => any>} [format] Object of column
 *  format options. The object keys should be column names. The object values
 *  should be formatting functions to invoke to transform column values prior
 *  to output. If specified, these override automatically inferred options.
 */

/**
 * Format a table as a comma-separated values (CSV) string. Other
 * delimiters, such as tabs or pipes ('|'), can be specified using
 * the options argument.
 * @param {ColumnTable} table The table to format.
 * @param {CSVFormatOptions} options The formatting options.
 * @return {string} A delimited-value format string.
 */
function toCSV(table, options = {}) {
  const names = columns(table, options.columns);
  const format = options.format || {};
  const delim = options.delimiter || ',';
  const reFormat = new RegExp(`["${delim}\n\r]`);

  const formatValue = value => value == null ? ''
    : isDate(value) ? formatUTCDate(value, true)
    : reFormat.test(value += '') ? '"' + value.replace(/"/g, '""') + '"'
    : value;

  const vals = names.map(formatValue);
  let text = '';

  scan(table, names, options.limit || Infinity, options.offset, {
    row() {
      text += vals.join(delim) + '\n';
    },
    cell(value, name, index) {
      vals[index] = formatValue(format[name] ? format[name](value) : value);
    }
  });

  return text + vals.join(delim);
}

/**
 * Column format object.
 * @typedef {object} ValueFormatObject
 * @property {boolean} [utc=false] If true, format dates in UTC time.
 * @property {number} [digits=0] The number of fractional digits to include
 *  when formatting numbers.
 * @property {number} [maxlen=30] The maximum string length for formatting
 *  nested object or array values.
 */

/**
 * @callback ValueFormatFunction
 * @param {*} value The value to format.
 * @return {*} A string-coercible or JSON-compatible formatted value.
 */

/**
 * Value format options.
 * @typedef {ValueFormatObject|ValueFormatFunction} ValueFormatOptions
 */

/**
 * Format a value as a string.
 * @param {*} v The value to format.
 * @param {ValueFormatOptions} options Formatting options.
 * @return {string} The formatted string.
 */
function formatValue(v, options = {}) {
  if (isFunction(options)) {
    return options(v) + '';
  }

  const type = typeof v;

  if (type === 'object') {
    if (isDate(v)) {
      return options.utc ? formatUTCDate(v) : formatDate(v);
    } else {
      const s = JSON.stringify(
        v,
        (k, v) => isTypedArray(v) ? Array.from(v) : v
      );
      const maxlen = options.maxlen || 30;
      return s.length > maxlen
        ? s.slice(0, 28) + '\u2026' + (s[0] === '[' ? ']' : '}')
        : s;
    }
  } else if (type === 'number') {
    const digits = options.digits || 0;
    let a;
    return v !== 0 && ((a = Math.abs(v)) >= 1e18 || a < Math.pow(10, -digits))
      ? v.toExponential(digits)
      : v.toFixed(digits);
  } else {
    return v + '';
  }
}

function map(obj, fn, output = {}) {
  for (const key in obj) {
    output[key] = fn(obj[key], key);
  }
  return output;
}

/**
 * Null format function.
 * @callback NullFormat
 * @param {null|undefined} [value] The value to format.
 * @return {string} The formatted HTML string.
 */

/**
 * CSS style function.
 * @callback StyleFunction
 * @param {string} name The column name.
 * @param {number} row The table row index.
 * @return {string} A CSS style string.
 */

/**
 * CSS style options.
 * @typedef {Object.<string, string | StyleFunction>} StyleOptions
 */

/**
 * Options for HTML formatting.
 * @typedef {object} HTMLFormatOptions
 * @property {number} [limit=Infinity] The maximum number of rows to print.
 * @property {number} [offset=0] The row offset indicating how many initial rows to skip.
 * @property {import('./util').ColumnSelectOptions} [columns] Ordered list
 *  of column names to include. If function-valued, the function should
 *  accept a table as input and return an array of column name strings.
 * @property {import('./util').ColumnAlignOptions} [align] Object of column
 *  alignment options. The object keys should be column names. The object
 *  values should be aligment strings, one of 'l' (left), 'c' (center), or
 *  'r' (right). If specified, these override automatically inferred options.
 * @property {import('./util').ColumnFormatOptions} [format] Object of column
 *  format options. The object keys should be column names. The object values
 *  should be formatting functions or specification objects. If specified,
 *  these override automatically inferred options.
 * @property {NullFormat} [null] Format function for null or undefined values.
 *  If specified, this function will be invoked with the null or undefined
 *  value as the sole input, and the return value will be used as the HTML
 *  output for the value.
 * @property {StyleOptions} [style] CSS styles to include in HTML output.
 *  The object keys should be HTML table tag names: 'table', 'thead',
 *  'tbody', 'tr', 'th', or 'td'. The object values should be strings of
 *  valid CSS style directives (such as "font-weight: bold;") or functions
 *  that take a column name and row as inputs and return a CSS string.
 * @property {number} [maxdigits=6] The maximum number of fractional digits
 *  to include when formatting numbers. This option is passed to the format
 *  inference method and is overridden by any explicit format options.
 */

/**
 * Format a table as an HTML table string.
 * @param {ColumnTable} table The table to format.
 * @param {HTMLFormatOptions} options The formatting options.
 * @return {string} An HTML table string.
 */
function toHTML(table, options = {}) {
  const names = columns(table, options.columns);
  const { align, format } = formats(table, names, options);
  const style = styles(options);
  const nullish = options.null;

  const alignValue = a => a === 'c' ? 'center' : a === 'r' ? 'right' : 'left';
  const escape = s => s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const baseFormat = (value, opt) => escape(formatValue(value, opt));
  const formatter = nullish
    ? (value, opt) => value == null ? nullish(value) : baseFormat(value, opt)
    : baseFormat;

  let r = -1;
  let idx = -1;

  const tag = (tag, name, shouldAlign) => {
    const a = shouldAlign ? alignValue(align[name]) : '';
    const s = style[tag] ? (style[tag](name, idx, r) || '') : '';
    const css = (a ? (`text-align: ${a};` + (s ? ' ' : '')) : '') + s;
    return `<${tag}${css ? ` style="${css}"` : ''}>`;
  };

  let text = tag('table')
    + tag('thead')
    + tag('tr', r)
    + names.map(name => `${tag('th', name, 1)}${name}</th>`).join('')
    + '</tr></thead>'
    + tag('tbody');

  scan(table, names, options.limit, options.offset, {
    row(row) {
      r = row;
      text += (++idx ? '</tr>' : '') + tag('tr');
    },
    cell(value, name) {
      text += tag('td', name, 1)
        + formatter(value, format[name])
        + '</td>';
    }
  });

  return text + '</tr></tbody></table>';
}

function styles(options) {
  return map(
    options.style,
    value => isFunction(value) ? value : () => value
  );
}

function defaultTrue(value, trueValue = true, falseValue = false) {
  return (value === undefined || value) ? trueValue : falseValue;
}

/**
 * Options for JSON formatting.
 * @typedef {object} JSONFormatOptions
 * @property {number} [limit=Infinity] The maximum number of rows to print.
 * @property {number} [offset=0] The row offset indicating how many initial
 *  rows to skip.
 * @property {boolean} [schema=true] Flag indicating if table schema metadata
 *  should be included in the JSON output. If false, only the data payload
 *  is included.
 * @property {import('./util').ColumnSelectOptions} [columns] Ordered list
 *  of column names to include. If function-valued, the function should
 *  accept a table as input and return an array of column name strings.
 * @property {Object.<string, (value: any) => any>} [format] Object of column
 *  format options. The object keys should be column names. The object values
 *  should be formatting functions to invoke to transform column values prior
 *  to output. If specified, these override automatically inferred options.
 */

const defaultFormatter = value => isDate(value)
  ? formatUTCDate(value, true)
  : value;

/**
 * Format a table as a JavaScript Object Notation (JSON) string.
 * @param {ColumnTable} table The table to format.
 * @param {JSONFormatOptions} options The formatting options.
 * @return {string} A JSON string.
 */
function toJSON(table, options = {}) {
  const schema = defaultTrue(options.schema);
  const format = options.format || {};
  const names = columns(table, options.columns);
  let text = '{';

  if (schema) {
    text += '"schema":{"fields":'
      + JSON.stringify(names.map(name => ({ name })))
      + '},"data":{';
  }

  names.forEach((name, i) => {
    text += (i ? ',' : '') + JSON.stringify(name) + ':[';

    const column = table.column(name);
    const formatter = format[name] || defaultFormatter;
    let r = -1;
    table.scan(row => {
      const value = column.get(row);
      text += (++r ? ',' : '') + JSON.stringify(formatter(value));
    }, true, options.limit, options.offset);

    text += ']';
  });

  return text + '}' + (schema ? '}' : '');
}

/**
 * Options for Markdown formatting.
 * @typedef {object} MarkdownFormatOptions
 * @property {number} [limit=Infinity] The maximum number of rows to print.
 * @property {number} [offset=0] The row offset indicating how many initial rows to skip.
 * @property {import('./util').ColumnSelectOptions} [columns] Ordered list
 *  of column names to include. If function-valued, the function should
 *  accept a table as input and return an array of column name strings.
 * @property {import('./util').ColumnAlignOptions} [align] Object of column
 *  alignment options. The object keys should be column names. The object
 *  values should be aligment strings, one of 'l' (left), 'c' (center), or
 *  'r' (right). If specified, these override automatically inferred options.
 * @property {import('./util').ColumnFormatOptions} [format] Object of column
 *  format options. The object keys should be column names. The object values
 *  should be formatting functions or specification objects. If specified,
 *  these override automatically inferred options.
 * @property {number} [maxdigits=6] The maximum number of fractional digits
 *  to include when formatting numbers. This option is passed to the format
 *  inference method and is overridden by any explicit format options.
 */

/**
 * Format a table as a GitHub-Flavored Markdown table string.
 * @param {ColumnTable} table The table to format.
 * @param {MarkdownFormatOptions} options The formatting options.
 * @return {string} A GitHub-Flavored Markdown table string.
 */
function toMarkdown(table, options = {}) {
  const names = columns(table, options.columns);
  const { align, format } = formats(table, names, options);

  const alignValue = a => a === 'c' ? ':-:' : a === 'r' ? '-:' : ':-';
  const escape = s => s.replace(/\|/g, '\\|');

  let text = '|'
    + names.map(escape).join('|')
    + '|\n|'
    + names.map(name => alignValue(align[name])).join('|')
    + '|';

  scan(table, names, options.limit, options.offset, {
    row() {
      text += '\n|';
    },
    cell(value, name) {
      text += escape(formatValue(value, format[name])) + '|';
    }
  });

  return text + '\n';
}

function assign(map, pairs) {
  for (const [key, value] of entries(pairs)) {
    map.set(key, value);
  }
  return map;
}

function escapeRegExp(str) {
  return str.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&');
}

function resolve(table, sel, map = new Map()) {
  sel = isNumber(sel) ? table.columnName(sel) : sel;

  if (isString(sel)) {
    map.set(sel, sel);
  } else if (isArray(sel)) {
    sel.forEach(r => resolve(table, r, map));
  } else if (isFunction(sel)) {
    resolve(table, sel(table), map);
  } else if (isObject(sel)) {
    assign(map, sel);
  } else {
    error(`Invalid column selection: ${toString(sel)}`);
  }

  return map;
}

function decorate(value, toObject) {
  value.toObject = toObject;
  return value;
}

function toObject$1(value) {
  return isArray(value) ? value.map(toObject$1)
    : value && value.toObject ? value.toObject()
    : value;
}

/**
 * Proxy type for SelectHelper function.
 * @typedef {import('../table/transformable').SelectHelper} SelectHelper
 */

/**
 * Select all columns in a table.
 * Returns a function-valued selection compatible with {@link Table#select}.
 * @return {SelectHelper} Selection function compatible with select().
 */
function all() {
  return decorate(
    table => table.columnNames(),
    () => ({ all: [] })
  );
}

/**
 * Negate a column selection, selecting all other columns in a table.
 * Returns a function-valued selection compatible with {@link Table#select}.
 * @param {...any} selection The selection to negate. May be a column name,
 *  column index, array of either, or a selection function (e.g., from range).
 * @return {SelectHelper} Selection function compatible with select().
 */
function not(...selection) {
  selection = selection.flat();
  return decorate(
    table => {
      const drop = resolve(table, selection);
      return table.columnNames(name => !drop.has(name));
    },
    () => ({ not: toObject$1(selection) })
  );
}

/**
 * Select a contiguous range of columns.
 * @param {string|number} start The name/index of the first selected column.
 * @param {string|number} end The name/index of the last selected column.
 * @return {SelectHelper} Selection function compatible with select().
 */
function range(start, end) {
  return decorate(
    table => {
      let i = isNumber(start) ? start : table.columnIndex(start);
      let j = isNumber(end) ? end : table.columnIndex(end);
      if (j < i) { const t = j; j = i; i = t; }
      return table.columnNames().slice(i, j + 1);
    },
    () => ({ range: [start, end] })
  );
}

/**
 * Select all columns whose names match a pattern.
 * @param {string|RegExp} pattern A string or regular expression pattern to match.
 * @return {SelectHelper} Selection function compatible with select().
 */
function matches(pattern) {
  if (isString(pattern)) pattern = RegExp(escapeRegExp(pattern));
  return decorate(
    table => table.columnNames(name => pattern.test(name)),
    () => ({ matches: [pattern.source, pattern.flags] })
  );
}

/**
 * Select all columns whose names start with a string.
 * @param {string} string The string to match at the start of the column name.
 * @return {SelectHelper} Selection function compatible with select().
 */
function startswith(string) {
  return matches(RegExp('^' + escapeRegExp(string)));
}

/**
 * Select all columns whose names end with a string.
 * @param {string} string The string to match at the end of the column name.
 * @return {SelectHelper} Selection function compatible with select().
 */
function endswith(string) {
  return matches(RegExp(escapeRegExp(string) + '$'));
}

function arrayType(column) {
  return isTypedArray(column.data) ? column.data.constructor : Array;
}

/**
 * Class representing a table backed by a named set of columns.
 */
class ColumnTable extends Table {

  /**
   * Create a new ColumnTable from existing input data.
   * @param {object[]|Iterable<object>|object|Map} values The backing table data values.
   *  If array-valued, should be a list of JavaScript objects with
   *  key-value properties for each column value.
   *  If object- or Map-valued, a table with two columns (one for keys,
   *  one for values) will be created.
   * @param {string[]} [names] The named columns to include.
   * @return {ColumnTable} A new ColumnTable instance.
   */
  static from(values, names) {
    return new ColumnTable(columnsFrom(values, names), names);
  }

  /**
   * Create a new table for a set of named columns.
   * @param {object|Map} columns
   *  The set of named column arrays. Keys are column names.
   *  The enumeration order of the keys determines the column indices,
   *  unless the names parameter is specified.
   *  Values must be arrays (or array-like values) of identical length.
   * @param {string[]} [names] Ordered list of column names. If specified,
   *  this array determines the column indices. If not specified, the
   *  key enumeration order of the columns object is used.
   * @return {ColumnTable} the instantiated ColumnTable instance.
   */
  static new(columns, names) {
    if (columns instanceof ColumnTable) return columns;
    const data = {};
    const keys = [];
    for (const [key, value] of entries(columns)) {
      data[key] = value;
      keys.push(key);
    }
    return new ColumnTable(data, names || keys);
  }

  /**
   * Instantiate a new ColumnTable instance.
   * @param {object} columns An object mapping column names to values.
   * @param {string[]} [names] An ordered list of column names.
   * @param {BitSet} [filter] A filtering BitSet.
   * @param {GroupBySpec} [group] A groupby specification.
   * @param {RowComparator} [order] A row comparator function.
   * @param {Params} [params] An object mapping parameter names to values.
   */
  constructor(columns, names, filter, group, order, params) {
    map(columns, defaultColumnFactory, columns);
    names = names || Object.keys(columns);
    const nrows = names.length ? columns[names[0]].length : 0;
    super(names, nrows, columns, filter, group, order, params);
  }

  /**
   * Create a new table with the same type as this table.
   * The new table may have different data, filter, grouping, or ordering
   * based on the values of the optional configuration argument. If a
   * setting is not specified, it is inherited from the current table.
   * @param {CreateOptions} [options] Creation options for the new table.
   * @return {ColumnTable} A newly created table.
   */
  create({ data, names, filter, groups, order }) {
    const f = filter !== undefined ? filter : this.mask();

    return new ColumnTable(
      data || this._data,
      names || (!data ? this._names : null),
      f,
      groups !== undefined ? groups : regroup(this._group, filter && f),
      order !== undefined ? order : this._order,
      this._params
    );
  }

  /**
   * Create a new table with additional columns drawn from one or more input
   * tables. All tables must have the same numer of rows and are reified
   * prior to assignment. In the case of repeated column names, input table
   * columns overwrite existing columns.
   * @param {...ColumnTable} tables The tables to merge with this table.
   * @return {ColumnTable} A new table with merged columns.
   * @example table.assign(table1, table2)
   */
  assign(...tables) {
    const nrows = this.numRows();
    const base = this.reify();
    const cset = columnSet(base).groupby(base.groups());
    tables.forEach(input => {
      input = ColumnTable.new(input);
      if (input.numRows() !== nrows) error('Assign row counts do not match');
      input = input.reify();
      input.columnNames(name => cset.add(name, input.column(name)));
    });
    return this.create(cset.new());
  }

  /**
   * Get the backing set of columns for this table.
   * @return {ColumnData} Object of named column instances.
   */
  columns() {
    return this._data;
  }

  /**
   * Get the column instance with the given name.
   * @param {string} name The column name.
   * @return {ColumnType | undefined} The named column, or undefined if it does not exist.
   */
  column(name) {
    return this._data[name];
  }

  /**
   * Get the column instance at the given index position.
   * @param {number} index The zero-based column index.
   * @return {ColumnType | undefined} The column, or undefined if it does not exist.
   */
  columnAt(index) {
    return this._data[this._names[index]];
  }

  /**
   * Get an array of values contained in a column. The resulting array
   * respects any table filter or orderby criteria.
   * @param {string} name The column name.
   * @param {ArrayConstructor|import('./table').TypedArrayConstructor} [constructor=Array]
   *  The array constructor for instantiating the output array.
   * @return {import('./table').DataValue[]|import('./table).TypedArray} The array of column values.
   */
  array(name, constructor = Array) {
    const column = this.column(name);
    const array = new constructor(this.numRows());
    let idx = -1;
    this.scan(row => array[++idx] = column.get(row), true);
    return array;
  }

  /**
   * Get the value for the given column and row.
   * @param {string} name The column name.
   * @param {number} [row=0] The row index, defaults to zero if not specified.
   * @return {import('./table').DataValue} The table value at (column, row).
   */
  get(name, row = 0) {
    const column = this.column(name);
    return this.isFiltered() || this.isOrdered()
      ? column.get(this.indices()[row])
      : column.get(row);
  }

  /**
   * Returns an accessor ("getter") function for a column. The returned
   * function takes a row index as its single argument and returns the
   * corresponding column value.
   * @param {string} name The column name.
   * @return {import('./table').ColumnGetter} The column getter function.
   */
  getter(name) {
    const column = this.column(name);
    const indices = this.isFiltered() || this.isOrdered() ? this.indices() : null;
    return indices ? row => column.get(indices[row])
      : column ? row => column.get(row)
      : error(`Unrecognized column: ${name}`);
  }

  /**
   * Returns an object representing a table row.
   * @param {number} [row=0] The row index, defaults to zero if not specified.
   * @return {object} A row object with named properties for each column.
   */
  object(row = 0) {
    return objectBuilder(this)(row);
  }

  /**
   * Returns an array of objects representing table rows.
   * @param {ObjectsOptions} [options] The options for row object generation.
   * @return {object[]} An array of row objects.
   */
  objects(options = {}) {
    const { grouped, limit, offset } = options;

    // generate array of row objects
    const names = resolve(this, options.columns || all());
    const create = rowObjectBuilder(names);
    const obj = [];
    this.scan(
      (row, data) => obj.push(create(row, data)),
      true, limit, offset
    );

    // produce nested output as requested
    if (grouped && this.isGrouped()) {
      const idx = [];
      this.scan(row => idx.push(row), true, limit, offset);
      return nest(this, idx, obj, grouped);
    }

    return obj;
  }

  /**
   * Returns an iterator over objects representing table rows.
   * @return {Iterator<object>} An iterator over row objects.
   */
  *[Symbol.iterator]() {
    const create = objectBuilder(this);
    const n = this.numRows();
    for (let i = 0; i < n; ++i) {
      yield create(i);
    }
  }

  /**
   * Create a new fully-materialized instance of this table.
   * All filter and orderby settings are removed from the new table.
   * Instead, the backing data itself is filtered and ordered as needed.
   * @param {number[]} [indices] Ordered row indices to materialize.
   *  If unspecified, all rows passing the table filter are used.
   * @return {ColumnTable} A reified table.
   */
  reify(indices) {
    const nrows = indices ? indices.length : this.numRows();
    const names = this._names;
    let data, groups;

    if (!indices && !this.isOrdered()) {
      if (!this.isFiltered()) {
        return this; // data already reified
      } else if (nrows === this.totalRows()) {
        data = this.data(); // all rows pass filter, skip copy
      }
    }

    if (!data) {
      const scan = indices ? f => indices.forEach(f) : f => this.scan(f, true);
      const ncols = names.length;
      data = {};

      for (let i = 0; i < ncols; ++i) {
        const name = names[i];
        const prev = this.column(name);
        const curr = data[name] = new (arrayType(prev))(nrows);
        let r = -1;
        scan(row => curr[++r] = prev.get(row));
      }

      if (this.isGrouped()) {
        groups = reindex(this.groups(), scan, !!indices, nrows);
      }
    }

    return this.create({ data, names, groups, filter: null, order: null });
  }

  /**
   * Apply a sequence of transformations to this table. The output
   * of each transform is passed as input to the next transform, and
   * the output of the last transform is then returned.
   * @param {...(Transform|Transform[])} transforms Transformation
   *  functions to apply to the table in sequence. Each function should
   *  take a single table as input and return a table as output.
   * @return {ColumnTable} The output of the last transform.
   */
  transform(...transforms) {
    return transforms.flat().reduce((t, f) => f(t), this);
  }

  /**
   * Format this table as an Apache Arrow table.
   * @param {ArrowFormatOptions} [options] The formatting options.
   * @return {import('apache-arrow').Table} An Apache Arrow table.
   */
  toArrow(options) {
    return toArrow(this, options);
  }

  /**
   * Format this table as binary data in the Apache Arrow IPC format.
   * @param {ArrowFormatOptions} [options] The formatting options. Set {format: 'stream'} 
   *        or {format:"file"} for specific IPC format
   * @return {Uint8Array} A new Uint8Array of Arrow-encoded binary data.
   */
  toArrowBuffer(options) {
    return toArrowIPC(this, options);
  }

  /**
   * Format this table as a comma-separated values (CSV) string. Other
   * delimiters, such as tabs or pipes ('|'), can be specified using
   * the options argument.
   * @param {CSVFormatOptions} [options] The formatting options.
   * @return {string} A delimited value string.
   */
  toCSV(options) {
    return toCSV(this, options);
  }

  /**
   * Format this table as an HTML table string.
   * @param {HTMLFormatOptions} [options] The formatting options.
   * @return {string} An HTML table string.
   */
  toHTML(options) {
    return toHTML(this, options);
  }

  /**
   * Format this table as a JavaScript Object Notation (JSON) string.
   * @param {JSONFormatOptions} [options] The formatting options.
   * @return {string} A JSON string.
   */
  toJSON(options) {
    return toJSON(this, options);
  }

  /**
   * Format this table as a GitHub-Flavored Markdown table string.
   * @param {MarkdownFormatOptions} [options] The formatting options.
   * @return {string} A GitHub-Flavored Markdown table string.
   */
  toMarkdown(options) {
    return toMarkdown(this, options);
  }
}

function objectBuilder(table) {
  let b = table._builder;

  if (!b) {
    const create = rowObjectBuilder(table.columnNames());
    const data = table.data();
    if (table.isOrdered() || table.isFiltered()) {
      const indices = table.indices();
      b = row => create(indices[row], data);
    } else {
      b = row => create(row, data);
    }
    table._builder = b;
  }

  return b;
}

/**
 * A table transformation.
 * @typedef {(table: ColumnTable) => ColumnTable} Transform
 */

/**
 * Proxy type for BitSet class.
 * @typedef {import('./table').BitSet} BitSet
 */

/**
 * Proxy type for ColumnType interface.
 * @typedef {import('./column').ColumnType} ColumnType
 */

/**
 * A named collection of columns.
 * @typedef {{[key: string]: ColumnType}} ColumnData
 */

/**
 * Proxy type for GroupBySpec.
 * @typedef {import('./table').GroupBySpec} GroupBySpec
 */

/**
 * Proxy type for RowComparator.
 * @typedef {import('./table').RowComparator} RowComparator
 */

/**
 * Proxy type for Params.
 * @typedef {import('./table').Params} Params
 */

/**
 * Options for Arrow formatting.
 * @typedef {import('../arrow/encode').ArrowFormatOptions} ArrowFormatOptions
 */

/**
 * Options for CSV formatting.
 * @typedef {import('../format/to-csv').CSVFormatOptions} CSVFormatOptions
 */

/**
 * Options for HTML formatting.
 * @typedef {import('../format/to-html').HTMLFormatOptions} HTMLFormatOptions
 */

/**
 * Options for JSON formatting.
 * @typedef {import('../format/to-json').JSONFormatOptions} JSONFormatOptions
 */

/**
 * Options for Markdown formatting.
 * @typedef {import('../format/to-markdown').MarkdownFormatOptions} MarkdownFormatOptions
 */

/**
 * Abstract class for custom aggregation operations.
 */
class Reducer {
  constructor(outputs) {
    this._outputs = outputs;
  }

  size() {
    return this._outputs.length;
  }

  outputs() {
    return this._outputs;
  }

  init(/* columns */) {
    return {};
  }

  add(/* state, row, data */) {
    // no-op, subclasses should override
  }

  rem(/* state, row, data */) {
    // no-op, subclasses should override
  }

  write(/* state, values, index */) {
  }
}

function walk(node, ctx, visitors, parent) {
  const visit = visitors[node.type] || visitors['Default'];
  if (visit && visit(node, ctx, parent) === false) return;

  const walker = walkers[node.type];
  if (walker) walker(node, ctx, visitors);
}

const unary = (node, ctx, visitors) => {
  walk(node.argument, ctx, visitors, node);
};

const binary = (node, ctx, visitors) => {
  walk(node.left, ctx, visitors, node);
  walk(node.right, ctx, visitors, node);
};

const ternary = (node, ctx, visitors) => {
  walk(node.test, ctx, visitors, node);
  walk(node.consequent, ctx, visitors, node);
  if (node.alternate) walk(node.alternate, ctx, visitors, node);
};

const func$1 = (node, ctx, visitors) => {
  list(node.params, ctx, visitors, node);
  walk(node.body, ctx, visitors, node);
};

const call = (node, ctx, visitors) => {
  walk(node.callee, ctx, visitors, node);
  list(node.arguments, ctx, visitors, node);
};

const list = (nodes, ctx, visitors, node) => {
  nodes.forEach(item => walk(item, ctx, visitors, node));
};

const walkers = {
  TemplateLiteral: (node, ctx, visitors) => {
    list(node.expressions, ctx, visitors, node);
    list(node.quasis, ctx, visitors, node);
  },
  MemberExpression: (node, ctx, visitors) => {
    walk(node.object, ctx, visitors, node);
    walk(node.property, ctx, visitors, node);
  },
  CallExpression: call,
  NewExpression: call,
  ArrayExpression: (node, ctx, visitors) => {
    list(node.elements, ctx, visitors, node);
  },
  AssignmentExpression: binary,
  AwaitExpression: unary,
  BinaryExpression: binary,
  LogicalExpression: binary,
  UnaryExpression: unary,
  UpdateExpression: unary,
  ConditionalExpression: ternary,
  ObjectExpression: (node, ctx, visitors) => {
    list(node.properties, ctx, visitors, node);
  },
  Property: (node, ctx, visitors) => {
    walk(node.key, ctx, visitors, node);
    walk(node.value, ctx, visitors, node);
  },

  ArrowFunctionExpression: func$1,
  FunctionExpression: func$1,
  FunctionDeclaration: func$1,

  VariableDeclaration: (node, ctx, visitors) => {
    list(node.declarations, ctx, visitors, node);
  },
  VariableDeclarator: (node, ctx, visitors) => {
    walk(node.id, ctx, visitors, node);
    walk(node.init, ctx, visitors, node);
  },
  SpreadElement: (node, ctx, visitors) => {
    walk(node.argument, ctx, visitors, node);
  },

  BlockStatement: (node, ctx, visitors) => {
    list(node.body, ctx, visitors, node);
  },
  ExpressionStatement: (node, ctx, visitors) => {
    walk(node.expression, ctx, visitors, node);
  },
  IfStatement: ternary,
  ForStatement: (node, ctx, visitors) => {
    walk(node.init, ctx, visitors, node);
    walk(node.test, ctx, visitors, node);
    walk(node.update, ctx, visitors, node);
    walk(node.body, ctx, visitors, node);
  },
  WhileStatement: (node, ctx, visitors) => {
    walk(node.test, ctx, visitors, node);
    walk(node.body, ctx, visitors, node);
  },
  DoWhileStatement: (node, ctx, visitors) => {
    walk(node.body, ctx, visitors, node);
    walk(node.test, ctx, visitors, node);
  },
  SwitchStatement: (node, ctx, visitors) => {
    walk(node.discriminant, ctx, visitors, node);
    list(node.cases, ctx, visitors, node);
  },
  SwitchCase: (node, ctx, visitors) => {
    if (node.test) walk(node.test, ctx, visitors, node);
    list(node.consequent, ctx, visitors, node);
  },
  ReturnStatement: unary,

  Program: (node, ctx, visitors) => {
    walk(node.body[0], ctx, visitors, node);
  }
};

function strip(node) {
  delete node.start;
  delete node.end;
  delete node.optional;
}

function stripMember(node) {
  strip(node);
  delete node.object;
  delete node.property;
  delete node.computed;
  if (!node.table) delete node.table;
}

function clean(ast) {
  walk(ast, null, {
    Column: stripMember,
    Constant: stripMember,
    Default: strip
  });
  return ast;
}

function is(type, node) {
  return node && node.type === type;
}

function isFunctionExpression(node) {
  return is(FunctionExpression, node)
    || is(ArrowFunctionExpression, node);
}

function toFunction(value) {
  return isFunction(value) ? value : () => value;
}

const ERROR_ESC_AGGRONLY = 'Escaped functions are not valid as rollup or pivot values.';

function parseEscape(ctx, spec, params) {
  if (ctx.aggronly) error(ERROR_ESC_AGGRONLY);

  // generate escaped function invocation code
  const code = '(row,data)=>fn('
    + rowObjectCode(ctx.table.columnNames())
    + ',$)';

  return { escape: compile$1.escape(code, toFunction(spec.expr), params) };
}

var constants = {
  undefined: 'void(0)',
  Infinity:  'Number.POSITIVE_INFINITY',
  NaN:       'Number.NaN',
  E:         'Math.E',
  LN2:       'Math.LN2',
  LN10:      'Math.LN10',
  LOG2E:     'Math.LOG2E',
  LOG10E:    'Math.LOG10E',
  PI:        'Math.PI',
  SQRT1_2:   'Math.SQRT1_2',
  SQRT2:     'Math.SQRT2'
};

const PARSER_OPT = { ecmaVersion: 11 };
const DEFAULT_PARAM_ID = '$';
const DEFAULT_TUPLE_ID = 'd';
const DEFAULT_TUPLE_ID1 = 'd1';
const DEFAULT_TUPLE_ID2 = 'd2';

const NO = msg => (node, ctx) => ctx.error(node, msg + ' not allowed');
const ERROR_AGGREGATE = NO('Aggregate function');
const ERROR_WINDOW = NO('Window function');
const ERROR_ARGUMENT = 'Invalid argument';
const ERROR_COLUMN = 'Invalid column reference';
const ERROR_AGGRONLY = ERROR_COLUMN + ' (must be input to an aggregate function)';
const ERROR_FUNCTION = 'Invalid function call';
const ERROR_MEMBER = 'Invalid member expression';
const ERROR_OP_PARAMETER = 'Invalid operator parameter';
const ERROR_PARAM = 'Invalid param reference';
const ERROR_VARIABLE = 'Invalid variable reference';
const ERROR_VARIABLE_OP = 'Variable not accessible in operator call';
const ERROR_DECLARATION = 'Unsupported variable declaration';
const ERROR_DESTRUCTURE = 'Unsupported destructuring pattern';
const ERROR_CLOSURE = 'Table expressions do not support closures';
const ERROR_ESCAPE = 'Use aq.escape(fn) to use a function as-is (including closures)';
const ERROR_USE_PARAMS = 'use table.params({ name: value }) to define dynamic parameters';
const ERROR_ADD_FUNCTION = 'use aq.addFunction(name, fn) to add new op functions';
const ERROR_VARIABLE_NOTE = `\nNote: ${ERROR_CLOSURE}. ${ERROR_ESCAPE}, or ${ERROR_USE_PARAMS}.`;
const ERROR_FUNCTION_NOTE = `\nNote: ${ERROR_CLOSURE}. ${ERROR_ESCAPE}, or ${ERROR_ADD_FUNCTION}.`;
const ERROR_ROW_OBJECT = `The ${ROW_OBJECT} method is not valid in multi-table expressions.`;

function parseExpression(ctx, spec) {
  const ast = parseAST(spec);
  let node = ctx.root = ast;
  ctx.spec = spec;
  ctx.tuple = null;
  ctx.tuple1 = null;
  ctx.tuple2 = null;
  ctx.$param = null;
  ctx.$op = 0;
  ctx.scope = new Set();
  ctx.paramsRef = new Map();
  ctx.columnRef = new Map();

  // parse input column parameters
  // if no function def, assume default tuple identifiers
  if (isFunctionExpression(node)) {
    parseFunction(node, ctx);
    node = node.body;
  } else if (ctx.join) {
    ctx.scope.add(ctx.tuple1 = DEFAULT_TUPLE_ID1);
    ctx.scope.add(ctx.tuple2 = DEFAULT_TUPLE_ID2);
    ctx.scope.add(ctx.$param = DEFAULT_PARAM_ID);
  } else {
    ctx.scope.add(ctx.tuple = DEFAULT_TUPLE_ID);
    ctx.scope.add(ctx.$param = DEFAULT_PARAM_ID);
  }

  // rewrite column references & function calls
  walk(node, ctx, visitors);

  return ctx.root;
}

function parseAST(expr) {
  try {
    const code = expr.field ? fieldRef(expr)
      : isArray(expr) ? toString(expr)
      : expr;
    return acorn.parse(`expr=(${code})`, PARSER_OPT).body[0].expression.right;
  } catch (err) {
    error(`Expression parse error: ${expr+''}`);
  }
}

function fieldRef(expr) {
  const col = JSON.stringify(expr+'');
  return !(expr.table || 0) ? `d=>d[${col}]` : `(a,b)=>b[${col}]`;
}

const visitors = {
  FunctionDeclaration: NO('Function definitions'),
  ForStatement: NO('For loops'),
  ForOfStatement: NO('For-of loops'),
  ForInStatement: NO('For-in loops'),
  WhileStatement: NO('While loops'),
  DoWhileStatement: NO('Do-while loops'),
  AwaitExpression: NO('Await expressions'),
  ArrowFunctionExpression: NO('Function definitions'),
  AssignmentExpression: NO('Assignments'),
  FunctionExpression: NO('Function definitions'),
  NewExpression: NO('Use of "new"'),
  UpdateExpression: NO('Update expressions'),

  VariableDeclarator(node, ctx) {
    handleDeclaration(node.id, ctx);
  },
  Identifier(node, ctx, parent) {
    if (handleIdentifier(node, ctx, parent) && !ctx.scope.has(node.name)) {
      // handle identifier passed responsibility here
      // raise error if identifier not defined in scope
      ctx.error(node, ERROR_VARIABLE, ERROR_VARIABLE_NOTE);
    }
  },
  CallExpression(node, ctx) {
    const name = functionName(node.callee);
    const def = getAggregate(name) || getWindow(name);

    // parse operator and rewrite invocation
    if (def) {
      if ((ctx.join || ctx.aggregate === false) && hasAggregate(name)) {
        ERROR_AGGREGATE(node, ctx);
      }
      if ((ctx.join || ctx.window === false) && hasWindow(name)) {
        ERROR_WINDOW(node, ctx);
      }

      ctx.$op = 1;
      if (ctx.ast) {
        updateFunctionNode(node, name, ctx);
        node.arguments.forEach(arg => walk(arg, ctx, opVisitors));
      } else {
        const op = ctx.op(parseOperator(ctx, def, name, node.arguments));
        Object.assign(node, { type: Op, name: op.id });
      }
      ctx.$op = 0;
      return false;
    } else if (hasFunction(name)) {
      updateFunctionNode(node, name, ctx);
    } else {
      ctx.error(node, ERROR_FUNCTION, ERROR_FUNCTION_NOTE);
    }
  },
  MemberExpression(node, ctx, parent) {
    const { object, property } = node;

    // bail if left head is not an identifier
    // in this case we will recurse and handle it later
    if (!is(Identifier, object)) return;
    const { name } = object;

    // allow use of Math prefix to access constant values
    if (isMath(node) && is(Identifier, property)
        && has(constants, property.name)) {
      updateConstantNode(node, property.name);
      return;
    }

    const index = name === ctx.tuple ? 0
      : name === ctx.tuple1 ? 1
      : name === ctx.tuple2 ? 2
      : -1;

    if (index >= 0) {
      // replace member expression with column ref
      return spliceMember(node, index, ctx, checkColumn, parent);
    } else if (name === ctx.$param) {
      // replace member expression with param ref
      return spliceMember(node, index, ctx, checkParam);
    } else if (ctx.paramsRef.has(name)) {
      updateParameterNode(node, ctx.paramsRef.get(name));
    } else if (ctx.columnRef.has(name)) {
      updateColumnNode(object, name, ctx, node);
    } else if (has(ctx.params, name)) {
      updateParameterNode(object, name);
    }
  }
};

function spliceMember(node, index, ctx, check, parent) {
  const { property, computed } = node;
  let name;

  if (!computed) {
    name = property.name;
  } else if (is(Literal, property)) {
    name = property.value;
  } else try {
    // visit subtree to ensure nodes are rewritten as needed
    // then compile the code to compute the property name
    walk(property, ctx, visitors, node);
    name = ctx.param(property);
  } catch (e) {
    ctx.error(node, ERROR_MEMBER);
  }

  check(node, name, index, ctx, parent);
  return false;
}

const opVisitors = {
  ...visitors,
  VariableDeclarator: NO('Variable declaration in operator call'),
  Identifier(node, ctx, parent) {
    if (handleIdentifier(node, ctx, parent)) {
      ctx.error(node, ERROR_VARIABLE_OP);
    }
  },
  CallExpression(node, ctx) {
    const name = functionName(node.callee);

    // rewrite if built-in function
    if (hasFunction(name)) {
      updateFunctionNode(node, name, ctx);
    } else {
      ctx.error(node, ERROR_FUNCTION, ERROR_FUNCTION_NOTE);
    }
  }
};

function parseFunction(node, ctx) {
  if (node.generator) NO('Generator functions')(node, ctx);
  if (node.async) NO('Async functions')(node, ctx);

  const { params } = node;
  const len = params.length;
  const setc = index => (name, key) => ctx.columnRef.set(name, [key, index]);
  const setp = (name, key) => ctx.paramsRef.set(name, key);

  if (!len) ; else if (ctx.join) {
    parseRef(ctx, params[0], 'tuple1', setc(1));
    if (len > 1) parseRef(ctx, params[1], 'tuple2', setc(2));
    if (len > 2) parseRef(ctx, params[2], '$param', setp);
  } else {
    parseRef(ctx, params[0], 'tuple', setc(0));
    if (len > 1) parseRef(ctx, params[1], '$param', setp);
  }

  ctx.root = node.body;
}

function parseRef(ctx, node, refName, alias) {
  if (is(Identifier, node)) {
    ctx.scope.add(node.name);
    ctx[refName] = node.name;
  } else if (is(ObjectPattern, node)) {
    node.properties.forEach(p => {
      const key = is(Identifier, p.key) ? p.key.name
        : is(Literal, p.key) ? p.key.value
        : ctx.error(p, ERROR_ARGUMENT);
      if (!is(Identifier, p.value)) {
        ctx.error(p.value, ERROR_DESTRUCTURE);
      }
      alias(p.value.name, key);
    });
  }
}

function parseOperator(ctx, def, name, args) {
  const fields = [];
  const params = [];
  const idxFields = def.param[0] || 0;
  const idxParams = idxFields + (def.param[1] || 0);

  args.forEach((arg, index) => {
    if (index < idxFields) {
      walk(arg, ctx, opVisitors);
      fields.push(ctx.field(arg));
    } else if (index < idxParams) {
      walk(arg, ctx, opVisitors);
      params.push(ctx.param(arg));
    } else {
      ctx.error(arg, ERROR_OP_PARAMETER);
    }
  });

  return { name, fields, params, ...(ctx.spec.window || {}) };
}

function functionName(node) {
  return is(Identifier, node) ? node.name
    : !is(MemberExpression, node) ? null
    : isMath(node) ? rewriteMath(node.property.name)
    : node.property.name;
}

function isMath(node) {
  return is(Identifier, node.object) && node.object.name === 'Math';
}

function rewriteMath(name) {
  return name === 'max' ? 'greatest'
    : name === 'min' ? 'least'
    : name;
}

function handleIdentifier(node, ctx, parent) {
  const { name } = node;

  if (is(MemberExpression, parent) && parent.property === node) ; else if (is(Property, parent) && parent.key === node) ; else if (ctx.paramsRef.has(name)) {
    updateParameterNode(node, ctx.paramsRef.get(name));
  } else if (ctx.columnRef.has(name)) {
    updateColumnNode(node, name, ctx, parent);
  } else if (has(ctx.params, name)) {
    updateParameterNode(node, name);
  } else if (has(constants, name)) {
    updateConstantNode(node, name);
  } else {
    return true;
  }
}

function checkColumn(node, name, index, ctx, parent) {
  // check column existence if we have a backing table
  const table = index === 0 ? ctx.table
    : index > 0 ? ctx.join[index - 1]
    : null;
  const col = table && table.column(name);
  if (table && !col) {
    ctx.error(node, ERROR_COLUMN);
  }

  // check if column reference is valid in current context
  if (ctx.aggronly && !ctx.$op) {
    ctx.error(node, ERROR_AGGRONLY);
  }

  // rewrite ast node as a column access
  rewrite(node, name, index, col, parent);
}

function updateColumnNode(node, key, ctx, parent) {
  const [name, index] = ctx.columnRef.get(key);
  checkColumn(node, name, index, ctx, parent);
}

function checkParam(node, name, index, ctx) {
  if (ctx.params && !has(ctx.params, name)) {
    ctx.error(node, ERROR_PARAM);
  }
  updateParameterNode(node, name);
}

function updateParameterNode(node, name) {
  node.type = Parameter;
  node.name = name;
}

function updateConstantNode(node, name) {
  node.type = Constant;
  node.name = name;
  node.raw = constants[name];
}

function updateFunctionNode(node, name, ctx) {
  if (name === ROW_OBJECT) {
    const t = ctx.table;
    if (!t) ctx.error(node, ERROR_ROW_OBJECT);
    rowObjectExpression(node,
      node.arguments.length
        ? node.arguments.map(node => {
            const col = ctx.param(node);
            const name = isNumber(col) ? t.columnName(col) : col;
            if (!t.column(name)) ctx.error(node, ERROR_COLUMN);
            return name;
          })
        : t.columnNames()
    );
  } else {
    node.callee = { type: Function$1, name };
  }
}

function handleDeclaration(node, ctx) {
  if (is(Identifier, node)) {
    ctx.scope.add(node.name);
  } else if (is(ArrayPattern, node)) {
    node.elements.forEach(elm => handleDeclaration(elm, ctx));
  } else if (is(ObjectPattern, node)) {
    node.properties.forEach(prop => handleDeclaration(prop.value, ctx));
  } else {
    ctx.error(node.id, ERROR_DECLARATION);
  }
}

const ANNOTATE = { [Column]: 1, [Op]: 1 };

function parse$2(input, opt = {}) {
  const generate = opt.generate || codegen;
  const compiler = opt.compiler || compile$1;
  const params = getParams(opt);
  const fields = {};
  const opcall = {};
  const names = [];
  const exprs = [];
  let fieldId = 0;
  let opId = -1;

  const compileExpr = opt.join ? compiler.join
    : opt.index == 1 ? compiler.expr2
    : compiler.expr;

  // parser context
  const ctx = {
    op(op) {
      const key = opKey(op);
      return opcall[key] || (op.id = ++opId, opcall[key] = op);
    },
    field(node) {
      const code = generate(node);
      return fields[code] || (fields[code] = ++fieldId);
    },
    param(node) {
      return is(Literal, node)
        ? node.value
        : compiler.param(generate(node), params);
    },
    value(name, node) {
      names.push(name);
      const e = node.escape || (opt.ast
        ? clean(node)
        : compileExpr(generate(node), params));
      exprs.push(e);
      // annotate expression if it is a direct column or op access
      // this permits downstream optimizations
      if (ANNOTATE[node.type] && e !== node && isObject(e)) {
        e.field = node.name;
      }
    },
    error(node, msg, note = '') {
      // both expresions and fields are parsed
      // with added code prefixes of length 6!
      const i = node.start - 6;
      const j = node.end - 6;
      const snippet = String(ctx.spec).slice(i, j);
      error(`${msg}: "${snippet}"${note}`);
    }
  };

  // copy all options to context, potentially overwriting methods
  Object.assign(ctx, opt, { params });

  // parse each expression
  for (const [name, value] of entries(input)) {
    ctx.value(
      name + '',
      value.escape
        ? parseEscape(ctx, value, params)
        : parseExpression(ctx, value)
    );
  }

  // return expression asts if requested
  if (opt.ast) {
    return { names, exprs };
  }

  // compile input field accessors
  const f = [];
  for (const key in fields) {
    f[fields[key]] = compiler.expr(key, params);
  }

  // resolve input fields to operations
  const ops = Object.values(opcall);
  ops.forEach(op => op.fields = op.fields.map(id => f[id]));

  return { names, exprs, ops };
}

function opKey(op) {
  let key = `${op.name}(${op.fields.concat(op.params).join(',')})`;
  if (op.frame) {
    const frame = op.frame.map(v => Number.isFinite(v) ? Math.abs(v) : -1);
    key += `[${frame},${!!op.peers}]`;
  }
  return key;
}

function getParams(opt) {
  return (opt.table ? getTableParams(opt.table)
    : opt.join ? {
        ...getTableParams(opt.join[1]),
        ...getTableParams(opt.join[0])
      }
    : {}) || {};
}

function getTableParams(table) {
  return table && isFunction(table.params) ? table.params() : {};
}

const Expr = 'Expr';
const ExprList = 'ExprList';
const ExprNumber = 'ExprNumber';
const ExprObject = 'ExprObject';
const JoinKeys = 'JoinKeys';
const JoinValues = 'JoinValues';
const Options = 'Options';
const OrderbyKeys = 'OrderKeys';
const SelectionList = 'SelectionList';
const TableRef = 'TableRef';
const TableRefList = 'TableRefList';

const Descending = 'Descending';
const Query$1 = 'Query';
const Selection = 'Selection';
const Verb$1 = 'Verb';
const Window = 'Window';

/**
 * Annotate an expression in an object wrapper.
 * @param {string|Function|object} expr An expression to annotate.
 * @param {object} properties The properties to annotate with.
 * @return {object} A new wrapped expression object.
 */
function wrap(expr, properties) {
  return expr && expr.expr
    ? new Wrapper({ ...expr, ...properties })
    : new Wrapper(properties, expr);
}

class Wrapper {
  constructor(properties, expr) {
    this.expr = expr;
    Object.assign(this, properties);
  }
  toString() {
    return String(this.expr);
  }
  toObject() {
    return {
      ...this,
      expr: this.toString(),
      ...(isFunction(this.expr) ? { func: true } : {})
    };
  }
}

/**
 * Annotate a table expression to indicate descending sort order.
 * @param {string|Function|object} expr The table expression to annotate.
 * @return {object} A wrapped expression indicating descending sort.
 * @example desc('colA')
 * @example desc(d => d.colA)
 */
function desc(expr) {
  return wrap(expr, { desc: true });
}

/**
 * Annotate an expression to indicate it is a string field reference.
 * @param {string|object} expr The column name, or an existing wrapped
 *  expression for a column name.
 * @param {string} [name] The column name to use. If provided, will
 *  overwrite the input expression value.
 * @param {number} [table=0] The table index of the field, in case of
 *  expressions over multiple tables.
 * @return A wrapped expression for a named column.
 * @example field('colA')
 */
function field(expr, name, table = 0) {
  const props = table ? { field: true, table } : { field: true };
  return wrap(
    expr,
    name ? { expr: name, ...props } : props
  );
}

/**
 * Annotate a table expression to compute rolling aggregate or window
 * functions within a sliding window frame. For example, to specify a
 * rolling 7-day average centered on the current day, use rolling with
 * a frame value of [-3, 3].
 * @param {string|Function|object} expr The table expression to annotate.
 * @param {[number?, number?]} [frame=[-Infinity, 0]] The sliding window frame
 *  offsets. Each entry indicates an offset from the current value. If an
 *  entry is non-finite, the frame will be unbounded in that direction,
 *  including all preceding or following values. If unspecified, the frame
 *  will include the current values and all preceding values.
 * @param {boolean} [includePeers=false] Indicates if the sliding window frame
 *  should ignore peer (tied) values. If false (the default), the window frame
 *  boundaries are insensitive to peer values. If `true`, the window frame
 *  expands to include all peers. This parameter only affects operations that
 *  depend on the window frame: aggregate functions and the first_value,
 *  last_value, and nth_value window functions.
 * @return A new wrapped expression annotated with rolling window parameters.
 * @example rolling(d => mean(d.colA), [-3, 3])
 * @example rolling(d => last_value(d.colA), null, true)
 */
function rolling(expr, frame, includePeers) {
  return wrap(expr, {
    window: {
      frame: frame || [-Infinity, 0],
      peers: !!includePeers
    }
  });
}

function func(expr) {
  const f = d => d;
  f.toString = () => expr;
  return f;
}

function getTable(catalog, ref) {
  ref = ref && isFunction(ref.query) ? ref.query() : ref;
  return ref && isFunction(ref.evaluate)
    ? ref.evaluate(null, catalog)
    : catalog(ref);
}

function isSelection(value) {
  return isObject(value) && (
    isArray(value.all) ||
    isArray(value.matches) ||
    isArray(value.not) ||
    isArray(value.range)
  );
}

function toObject(value) {
  return value && isFunction(value.toObject) ? value.toObject()
    : isFunction(value) ? { expr: String(value), func: true }
    : isArray(value) ? value.map(toObject)
    : isObject(value) ? map(value, _ => toObject(_))
    : value;
}

function fromObject(value) {
  return isArray(value) ? value.map(fromObject)
    : !isObject(value) ? value
    : isArray(value.verbs) ? Query.from(value)
    : isArray(value.all) ? all()
    : isArray(value.range) ? range(...value.range)
    : isArray(value.match) ? matches(RegExp(...value.match))
    : isArray(value.not) ? not(value.not.map(toObject))
    : fromExprObject(value);
}

function fromExprObject(value) {
  let output = value;
  let expr = value.expr;

  if (expr != null) {
    if (value.field === true) {
      output = expr = field(expr);
    } else if (value.func === true) {
      output = expr = func(expr);
    }

    if (isObject(value.window)) {
      const { frame, peers } = value.window;
      output = expr = rolling(expr, frame, peers);
    }

    if (value.desc === true) {
      output = desc(expr);
    }
  }

  return value === output
    ? map(value, _ => fromObject(_))
    : output;
}

function joinKeys(keys) {
  return isArray(keys) ? keys.map(parseJoinKeys)
    : keys;
}

function parseJoinKeys(keys) {
  const list = [];

  toArray(keys).forEach(param => {
    isNumber(param) ? list.push(param)
      : isString(param) ? list.push(field(param, null))
      : isObject(param) && param.expr ? list.push(param)
      : isFunction(param) ? list.push(param)
      : error(`Invalid key value: ${param+''}`);
  });

  return list;
}

function joinValues(values) {
  return isArray(values)
    ? values.map(parseJoinValues)
    : values;
}

function parseJoinValues(values, index) {
  return index < 2 ? toArray(values) : values;
}

function orderbyKeys(keys) {
  const list = [];

  keys.forEach(param => {
    const expr = param.expr != null ? param.expr : param;
    if (isObject(expr) && !isFunction(expr)) {
      for (const key in expr) {
        list.push(expr[key]);
      }
    } else {
      param = isNumber(expr) ? expr
        : isString(expr) ? field(param)
        : isFunction(expr) ? param
        : error(`Invalid orderby field: ${param+''}`);
      list.push(param);
    }
  });

  return list;
}

const Methods = {
  [Expr]: astExpr,
  [ExprList]: astExprList,
  [ExprNumber]: astExprNumber,
  [ExprObject]: astExprObject,
  [JoinKeys]: astJoinKeys,
  [JoinValues]: astJoinValues,
  [OrderbyKeys]: astExprList,
  [SelectionList]: astSelectionList
};

function toAST(value, type, propTypes) {
  return type === TableRef ? astTableRef(value)
    : type === TableRefList ? value.map(astTableRef)
    : ast(toObject(value), type, propTypes);
}

function ast(value, type, propTypes) {
  return type === Options
    ? (value ? astOptions(value, propTypes) : value)
    : Methods[type](value);
}

function astOptions(value, types = {}) {
  const output = {};
  for (const key in value) {
    const prop = value[key];
    output[key] = types[key] ? ast(prop, types[key]) : prop;
  }
  return output;
}

function astParse(expr, opt) {
  return parse$2({ expr }, { ...opt, ast: true }).exprs[0];
}

function astColumn(name) {
  return { type: Column, name };
}

function astColumnIndex(index) {
  return { type: Column, index };
}

function astExprObject(obj, opt) {
  if (isString(obj)) {
    return astParse(obj, opt);
  }

  if (obj.expr) {
    let ast;
    if (obj.field === true) {
      ast = astColumn(obj.expr);
    } else if (obj.func === true) {
      ast = astExprObject(obj.expr, opt);
    }
    if (ast) {
      if (obj.desc) {
        ast = { type: Descending, expr: ast };
      }
      if (obj.window) {
        ast = { type: Window, expr: ast, ...obj.window };
      }
      return ast;
    }
  }

  return Object.keys(obj)
    .map(key => ({
      ...astExprObject(obj[key], opt),
      as: key
    }));
}

function astSelection(sel) {
  const type = Selection;
  return sel.all ? { type, operator: 'all' }
    : sel.not ? { type, operator: 'not', arguments: astExprList(sel.not) }
    : sel.range ? { type, operator: 'range', arguments: astExprList(sel.range) }
    : sel.matches ? { type, operator: 'matches', arguments: sel.matches }
    : error('Invalid input');
}

function astSelectionList(arr) {
  return toArray(arr).map(astSelectionItem).flat();
}

function astSelectionItem(val) {
  return isSelection(val) ? astSelection(val)
    : isNumber(val) ? astColumnIndex(val)
    : isString(val) ? astColumn(val)
    : isObject(val) ? Object.keys(val)
      .map(name => ({ type: Column, name, as: val[name] }))
    : error('Invalid input');
}

function astExpr(val) {
  return isSelection(val) ? astSelection(val)
    : isNumber(val) ? astColumnIndex(val)
    : isString(val) ? astColumn(val)
    : isObject(val) ? astExprObject(val)
    : error('Invalid input');
}

function astExprList(arr) {
  return toArray(arr).map(astExpr).flat();
}

function astExprNumber(val) {
  return isNumber(val) ? val : astExprObject(val);
}

function astJoinKeys(val) {
  return isArray(val)
    ? val.map(astExprList)
    : astExprObject(val, { join: true });
}

function astJoinValues(val) {
  return isArray(val)
    ? val.map((v, i) => i < 2
        ? astExprList(v)
        : astExprObject(v, { join: true })
      )
    : astExprObject(val, { join: true });
}

function astTableRef(value) {
  return value && isFunction(value.toAST)
    ? value.toAST()
    : value;
}

/**
 * Model an Arquero verb as a serializable object.
 */
class Verb {

  /**
   * Construct a new verb instance.
   * @param {string} verb The verb name.
   * @param {object[]} schema Schema describing verb parameters.
   * @param {any[]} params Array of parameter values.
   */
  constructor(verb, schema = [], params = []) {
    this.verb = verb;
    this.schema = schema;
    schema.forEach((s, index) => {
      const type = s.type;
      const param = params[index];
      const value = type === JoinKeys ? joinKeys(param)
        : type === JoinValues ? joinValues(param)
        : type === OrderbyKeys ? orderbyKeys(param)
        : param;
      this[s.name] = value !== undefined ? value : s.default;
    });
  }

  /**
   * Create new verb instance from the given serialized object.
   * @param {object} object A serialized verb representation, such as
   *  those generated by Verb.toObject.
   * @returns {Verb} The instantiated verb.
   */
  static from(object) {
    const verb = Verbs[object.verb];
    const params = (verb.schema || [])
      .map(({ name }) => fromObject(object[name]));
    return verb(...params);
  }

  /**
   * Evaluate this verb against a given table and catalog.
   * @param {Table} table The Arquero table to process.
   * @param {Function} catalog A table lookup function that accepts a table
   *  name string as input and returns a corresponding Arquero table.
   * @returns {Table} The resulting Arquero table.
   */
  evaluate(table, catalog) {
    const params = this.schema.map(({ name, type }) => {
      const value = this[name];
      return type === TableRef ? getTable(catalog, value)
        : type === TableRefList ? value.map(t => getTable(catalog, t))
        : value;
    });
    return table[this.verb](...params);
  }

  /**
   * Serialize this verb as a JSON-compatible object. The resulting
   * object can be passed to Verb.from to re-instantiate this verb.
   * @returns {object} A JSON-compatible object representing this verb.
   */
  toObject() {
    const obj = { verb: this.verb };
    this.schema.forEach(({ name }) => {
      obj[name] = toObject(this[name]);
    });
    return obj;
  }

  /**
   * Serialize this verb to a JSON-compatible abstract syntax tree.
   * All table expressions will be parsed and represented as AST instances
   * using a modified form of the Mozilla JavaScript AST format.
   * This method can be used to output parsed and serialized representations
   * to translate Arquero verbs to alternative data processing platforms.
   * @returns {object} A JSON-compatible abstract syntax tree object.
   */
  toAST() {
    const obj = { type: Verb$1, verb: this.verb };
    this.schema.forEach(({ name, type, props }) => {
      obj[name] = toAST(this[name], type, props);
    });
    return obj;
  }
}

/**
 * Verb parameter type.
 * @typedef {Expr|ExprList|ExprNumber|ExprObject|JoinKeys|JoinValues|Options|OrderbyKeys|SelectionList|TableRef|TableRefList} ParamType
 */

/**
 * Verb parameter schema.
 * @typedef {object} ParamDef
 * @property {string} name The name of the parameter.
 * @property {ParamType} type The type of the parameter.
 * @property {{ [key: string]: ParamType }} [props] Types for non-literal properties.
 */

/**
 * Create a new constructors.
 * @param {string} name The name of the verb.
 * @param {ParamDef[]} schema The verb parameter schema.
 * @return {Function} A verb constructor function.
 */
function createVerb(name, schema) {
  return Object.assign(
    (...params) => new Verb(name, schema, params),
    { schema }
  );
}

/**
 * A lookup table of verb classes.
 */
const Verbs = {
  count:      createVerb('count', [
                { name: 'options', type: Options }
              ]),
  derive:     createVerb('derive', [
                { name: 'values', type: ExprObject },
                { name: 'options', type: Options,
                  props: { before: SelectionList, after: SelectionList }
                }
              ]),
  filter:     createVerb('filter', [
                { name: 'criteria', type: ExprObject }
              ]),
  groupby:    createVerb('groupby', [
                { name: 'keys', type: ExprList }
              ]),
  orderby:    createVerb('orderby', [
                { name: 'keys', type: OrderbyKeys }
              ]),
  relocate:   createVerb('relocate', [
                { name: 'columns', type: SelectionList },
                { name: 'options', type: Options,
                  props: { before: SelectionList, after: SelectionList }
                }
              ]),
  rename:     createVerb('rename', [
                { name: 'columns', type: SelectionList }
              ]),
  rollup:     createVerb('rollup', [
                { name: 'values', type: ExprObject }
              ]),
  sample:     createVerb('sample', [
                { name: 'size', type: ExprNumber },
                { name: 'options', type: Options, props: { weight: Expr } }
              ]),
  select:     createVerb('select', [
                { name: 'columns', type: SelectionList }
              ]),
  ungroup:    createVerb('ungroup'),
  unorder:    createVerb('unorder'),
  reify:      createVerb('reify'),
  dedupe:     createVerb('dedupe', [
                { name: 'keys', type: ExprList, default: [] }
              ]),
  impute:     createVerb('impute', [
                { name: 'values', type: ExprObject },
                { name: 'options', type: Options, props: { expand: ExprList } }
              ]),
  fold:       createVerb('fold', [
                { name: 'values', type: ExprList },
                { name: 'options', type: Options }
              ]),
  pivot:      createVerb('pivot', [
                { name: 'keys', type: ExprList },
                { name: 'values', type: ExprList },
                { name: 'options', type: Options }
              ]),
  spread:     createVerb('spread', [
                { name: 'values', type: ExprList },
                { name: 'options', type: Options }
              ]),
  unroll:     createVerb('unroll', [
                { name: 'values', type: ExprList },
                { name: 'options', type: Options, props: { drop: ExprList } }
              ]),
  lookup:     createVerb('lookup', [
                { name: 'table', type: TableRef },
                { name: 'on', type: JoinKeys },
                { name: 'values', type: ExprList }
              ]),
  join:       createVerb('join', [
                { name: 'table', type: TableRef },
                { name: 'on', type: JoinKeys },
                { name: 'values', type: JoinValues },
                { name: 'options', type: Options }
              ]),
  cross:      createVerb('cross', [
                { name: 'table', type: TableRef },
                { name: 'values', type: JoinValues },
                { name: 'options', type: Options }
              ]),
  semijoin:   createVerb('semijoin', [
                { name: 'table', type: TableRef },
                { name: 'on', type: JoinKeys }
              ]),
  antijoin:   createVerb('antijoin', [
                { name: 'table', type: TableRef },
                { name: 'on', type: JoinKeys }
              ]),
  concat:     createVerb('concat', [
                { name: 'tables', type: TableRefList }
              ]),
  union:      createVerb('union', [
                { name: 'tables', type: TableRefList }
              ]),
  intersect:  createVerb('intersect', [
                { name: 'tables', type: TableRefList }
              ]),
  except:     createVerb('except', [
                { name: 'tables', type: TableRefList }
              ])
};

/**
 * Create a new query instance. The query interface provides
 * a table-like verb API to construct a query that can be
 * serialized or evaluated against Arquero tables.
 * @param {string} [tableName] The name of the table to query. If
 *  provided, will be used as the default input table to pull from
 *  a provided catalog to run the query against.
 * @return {Query} A new builder instance.
 */
function query(tableName) {
  return new Query(null, null, tableName);
}

/**
 * Create a new query instance from a serialized object.
 * @param {object} object A serialized query representation, such as
 *  those generated by query(...).toObject().
 * @returns {Query} The instantiated query instance.
 */
function queryFrom(object) {
  return Query.from(object);
}

/**
 * Model a query as a collection of serializble verbs.
 * Provides a table-like interface for constructing queries.
 */
class Query extends Transformable {

  /**
   * Construct a new query instance.
   * @param {Verb[]} verbs An array of verb instances.
   * @param {object} [params] Optional query parameters, corresponding
   *  to parameter references in table expressions.
   * @param {string} [table] Optional name of the table to query.
   */
  constructor(verbs, params, table) {
    super(params);
    this._verbs = verbs || [];
    this._table = table;
  }

  /**
   * Create a new query instance from the given serialized object.
   * @param {QueryObject} object A serialized query representation, such as
   *  those generated by Query.toObject.
   * @returns {Query} The instantiated query.
   */
  static from({ verbs, table, params }) {
    return new Query(verbs.map(Verb.from), params, table);
  }

  /**
   * Provide an informative object string tag.
   */
  get [Symbol.toStringTag]() {
    if (!this._verbs) return 'Object'; // bail if called on prototype
    const ns = this._verbs.length;
    return `Query: ${ns} verbs` + (this._table ? ` on '${this._table}'` : '');
  }

  /**
   * Return the number of verbs in this query.
   */
  get length() {
    return this._verbs.length;
  }

  /**
   * Return the name of the table this query applies to.
   * @return {string} The name of the source table, or undefined.
   */
  get tableName() {
    return this._table;
  }

  /**
   * Get or set table expression parameter values.
   * If called with no arguments, returns the current parameter values
   * as an object. Otherwise, adds the provided parameters to this
   * query's parameter set and returns the table. Any prior parameters
   * with names matching the input parameters are overridden.
   * @param {object} values The parameter values.
   * @return {Query|object} The current parameter values (if called
   *  with no arguments) or this query.
   */
  params(values) {
    if (arguments.length) {
      this._params = { ...this._params, ...values };
      return this;
    } else {
      return this._params;
    }
  }

  /**
   * Evaluate this query against a given table and catalog.
   * @param {Table} table The Arquero table to process.
   * @param {Function} catalog A table lookup function that accepts a table
   *  name string as input and returns a corresponding Arquero table.
   * @returns {Table} The resulting Arquero table.
   */
  evaluate(table, catalog) {
    table = table || catalog(this._table);
    for (const verb of this._verbs) {
      table = verb.evaluate(table.params(this._params), catalog);
    }
    return table;
  }

  /**
   * Serialize this query as a JSON-compatible object. The resulting
   * object can be passed to Query.from to re-instantiate this query.
   * @returns {object} A JSON-compatible object representing this query.
   */
  toObject() {
    return serialize(this, 'toObject');
  }

  /**
   * Serialize this query as a JSON-compatible object. The resulting
   * object can be passed to Query.from to re-instantiate this query.
   * This method simply returns the result of toObject, but is provided
   * as a separate method to allow later customization of JSON export.
   * @returns {object} A JSON-compatible object representing this query.
   */
  toJSON() {
    return this.toObject();
  }

  /**
   * Serialize this query to a JSON-compatible abstract syntax tree.
   * All table expressions will be parsed and represented as AST instances
   * using a modified form of the Mozilla JavaScript AST format.
   * This method can be used to output parsed and serialized representations
   * to translate Arquero queries to alternative data processing platforms.
   * @returns {object} A JSON-compatible abstract syntax tree object.
   */
  toAST() {
    return serialize(this, 'toAST', { type: Query$1 });
  }
}

/**
 * Serialized object representation of a query.
 * @typedef {object} QueryObject
 * @property {object[]} verbs An array of verb definitions.
 * @property {object} [params] An object of parameter values.
 * @property {string} [table] The name of the table to query.
 */

function serialize(query, method, props) {
  return {
    ...props,
    verbs: query._verbs.map(verb => verb[method]()),
    ...(query._params ? { params: query._params } : null),
    ...(query._table ? { table: query._table } : null)
  };
}

function append(qb, verb) {
  return new Query(
    qb._verbs.concat(verb),
    qb._params,
    qb._table
  );
}

function addQueryVerb(name, verb) {
  Query.prototype[name] = function(...args) {
    return append(this, verb(...args));
  };
}

// Internal verb handlers
for (const name in Verbs) {
  const verb = Verbs[name];
  Query.prototype['__' + name] = function(qb, ...args) {
    return append(qb, verb(...args));
  };
}

var name = "arquero";
var version$1 = "5.4.0";
var description = "Query processing and transformation of array-backed data tables.";
var keywords = [
	"data",
	"query",
	"database",
	"table",
	"dataframe",
	"transform",
	"arrays"
];
var license = "BSD-3-Clause";
var author = "Jeffrey Heer (http://idl.cs.washington.edu)";
var main = "dist/arquero.node.js";
var module$1 = "src/index-node.js";
var unpkg = "dist/arquero.min.js";
var jsdelivr = "dist/arquero.min.js";
var types = "dist/types/index.d.ts";
var browser = {
	"./dist/arquero.node.js": "./dist/arquero.min.js",
	"./src/index-node.js": "./src/index.js"
};
var repository = {
	type: "git",
	url: "https://github.com/uwdata/arquero.git"
};
var scripts = {
	prebuild: "rimraf dist && mkdir dist",
	build: "rollup -c rollup.config.mjs",
	postbuild: "tsc",
	preperf: "npm run build",
	perf: "TZ=America/Los_Angeles tape 'perf/**/*-perf.js'",
	lint: "eslint src test --ext .js",
	test: "TZ=America/Los_Angeles tape 'test/**/*-test.js' --require esm",
	prepublishOnly: "npm test && npm run lint && npm run build"
};
var dependencies = {
	acorn: "^8.11.2",
	"apache-arrow": "^14.0.2",
	"node-fetch": "^2.6.7"
};
var devDependencies = {
	"@rollup/plugin-json": "^6.1.0",
	"@rollup/plugin-node-resolve": "^15.2.3",
	"@rollup/plugin-terser": "^0.4.4",
	eslint: "^8.56.0",
	esm: "^3.2.25",
	rimraf: "^5.0.5",
	rollup: "^4.9.1",
	"rollup-plugin-bundle-size": "^1.0.3",
	tape: "^5.7.2",
	typescript: "^5.3.3"
};
var esm = {
	force: true,
	mainFields: [
		"module",
		"main"
	]
};
var pkg = {
	name: name,
	version: version$1,
	description: description,
	keywords: keywords,
	license: license,
	author: author,
	main: main,
	module: module$1,
	unpkg: unpkg,
	jsdelivr: jsdelivr,
	types: types,
	browser: browser,
	repository: repository,
	scripts: scripts,
	dependencies: dependencies,
	devDependencies: devDependencies,
	esm: esm
};

/**
 * Create a new Arquero column that proxies access to an
 * Apache Arrow dictionary column.
 * @param {object} vector An Apache Arrow dictionary column.
 */
function arrowDictionary(vector) {
  const { data, length, nullCount } = vector;
  const dictionary = data[data.length - 1].dictionary;
  const size = dictionary.length;
  const keys = dictKeys(data || [vector], length, nullCount, size);
  const values = Array(size);

  const value = k => k == null || k < 0 || k >= size ? null
    : values[k] !== undefined ? values[k]
    : (values[k] = dictionary.get(k));

  return {
    vector,
    length,

    get: row => value(keys[row]),

    key: row => keys[row],

    keyFor(value) {
      if (value === null) return nullCount ? size : -1;
      for (let i = 0; i < size; ++i) {
        if (values[i] === undefined) values[i] = dictionary.get(i);
        if (values[i] === value) return i;
      }
      return -1;
    },

    groups(names) {
      const s = size + (nullCount ? 1 : 0);
      return { keys, get: [value], names, rows: sequence(0, s), size: s };
    },

    [Symbol.iterator]() {
      return vector[Symbol.iterator]();
    }
  };
}

/**
 * Generate a dictionary key array
 * @param {object[]} chunks Arrow column chunks
 * @param {number} length The length of the Arrow column
 * @param {number} nulls The count of column null values
 * @param {number} size The backing dictionary size
 */
function dictKeys(chunks, length, nulls, size) {
  const v = chunks.length > 1 || nulls
    ? flatten(chunks, length, chunks[0].type.indices)
    : chunks[0].values;
  return nulls ? nullKeys(chunks, v, size) : v;
}

/**
 * Flatten Arrow column chunks into a single array.
 */
function flatten(chunks, length, type) {
  const array = new type.ArrayType(length);
  const n = chunks.length;
  for (let i = 0, idx = 0, len; i < n; ++i) {
    len = chunks[i].length;
    array.set(chunks[i].values.subarray(0, len), idx);
    idx += len;
  }
  return array;
}

/**
 * Encode null values as an additional dictionary key.
 * Returns a new key array with null values added.
 * TODO: safeguard against integer overflow?
 */
function nullKeys(chunks, keys, key) {
  // iterate over null bitmaps, encode null values as key
  const n = chunks.length;
  for (let i = 0, idx = 0, m, base, bits, byte; i < n; ++i) {
    bits = chunks[i].nullBitmap;
    m = chunks[i].length >> 3;
    if (bits && bits.length) {
      for (let j = 0; j <= m; ++j) {
        if ((byte = bits[j]) !== 255) {
          base = idx + (j << 3);
          if ((byte & (1 << 0)) === 0) keys[base + 0] = key;
          if ((byte & (1 << 1)) === 0) keys[base + 1] = key;
          if ((byte & (1 << 2)) === 0) keys[base + 2] = key;
          if ((byte & (1 << 3)) === 0) keys[base + 3] = key;
          if ((byte & (1 << 4)) === 0) keys[base + 4] = key;
          if ((byte & (1 << 5)) === 0) keys[base + 5] = key;
          if ((byte & (1 << 6)) === 0) keys[base + 6] = key;
          if ((byte & (1 << 7)) === 0) keys[base + 7] = key;
        }
      }
    }
    idx += chunks[i].length;
  }
  return keys;
}

function unroll(args, code, ...lists) {
  const v = ['_', '$'];
  const a = v.slice(0, lists.length);
  a.push('"use strict"; const '
    + lists
        .map((l, j) => l.map((_, i) => `${v[j]}${i} = ${v[j]}[${i}]`).join(', '))
        .join(', ')
    + `; return (${args}) => ${code};`
  );
  return Function(...a)(...lists);
}

// Hardwire Arrow type ids to sidestep dependency
// https://github.com/apache/arrow/blob/master/js/src/enum.ts

const isDict = ({ typeId }) => typeId === -1;
const isUtf8 = ({ typeId }) => typeId === 5;
const isList = ({ typeId }) => typeId === 12;
const isStruct = ({ typeId }) => typeId === 13;
const isFixedSizeList = ({ typeId }) => typeId === 16;

const isListType = type => isList(type) || isFixedSizeList(type);

/**
 * Create an Arquero column that proxies access to an Arrow column.
 * @param {object} arrow An Apache Arrow column.
 * @return {import('../table/column').ColumnType} An Arquero-compatible column.
 */
function arrowColumn(vector, nested) {
  const { type, length, numChildren } = vector;
  if (isDict(type)) return arrowDictionary(vector);

  const get = numChildren && nested ? getNested(vector)
    : numChildren ? memoize(getNested(vector))
    : isUtf8(type) ? memoize(row => vector.get(row))
    : null;

  return get
    ? { vector, length, get, [Symbol.iterator]: () => iterator(length, get) }
    : vector;
}

function memoize(get) {
  const values = [];
  return row => {
    const v = values[row];
    return v !== undefined ? v : (values[row] = get(row));
  };
}

function* iterator(n, get) {
  for (let i = 0; i < n; ++i) {
    yield get(i);
  }
}

const arrayFrom = vector => vector.numChildren
  ? repeat(vector.length, getNested(vector))
  : vector.nullCount ? [...vector]
  : vector.toArray();

const getNested = vector => isListType(vector.type) ? getList(vector)
  : isStruct(vector.type) ? getStruct(vector)
  : error(`Unsupported Arrow type: ${toString(vector.VectorName)}`);

const getList = vector => vector.nullCount
  ? row => vector.isValid(row) ? arrayFrom(vector.get(row)) : null
  : row => arrayFrom(vector.get(row));

function getStruct(vector) {
  const props = [];
  const code = [];
  vector.type.children.forEach((field, i) => {
    props.push(arrowColumn(vector.getChildAt(i), true));
    code.push(`${toString(field.name)}:_${i}.get(row)`);
  });
  const get = unroll('row', '({' + code + '})', props);

  return vector.nullCount
    ? row => vector.isValid(row) ? get(row) : null
    : get;
}

/**
 * Options for Apache Arrow import.
 * @typedef {object} ArrowOptions
 * @property {import('../table/transformable').Select} columns
 *  An ordered set of columns to import. The input may consist of column name
 *  strings, column integer indices, objects with current column names as keys
 *  and new column names as values (for renaming), or selection helper
 *  functions such as {@link all}, {@link not}, or {@link range}.
 */

/**
 * Create a new table backed by an Apache Arrow table instance.
 * @param {object} arrow An Apache Arrow data table or byte buffer.
 * @param {ArrowOptions} options Options for Arrow import.
 * @return {ColumnTable} A new table containing the imported values.
 */
function fromArrow(arrow, options = {}) {
  if (arrow && !arrow.batches) {
    arrow = fromIPC()(arrow);
  }

  // resolve column selection
  const fields = arrow.schema.fields.map(f => f.name);
  const sel = resolve({
    columnNames: test => test ? fields.filter(test) : fields.slice(),
    columnIndex: name => fields.indexOf(name)
  }, options.columns || all());

  // build Arquero columns for backing Arrow columns
  const cols = columnSet();
  sel.forEach((name, key) => {
    cols.add(name, arrowColumn(arrow.getChild(key)));
  });

  return new ColumnTable(cols.data, cols.names);
}

var identity = x => x;

const parseBoolean = [ // boolean
  v => (v === 'true') || (v === 'false'),
  v => v === 'false' ? false : true
];

const parseNumber = [ // number
  v => v === 'NaN' || (v = +v) === v,
  v => +v
];

const parseDate = [ // iso date
  isISODateString,
  v => new Date(Date.parse(v))
];

function numberParser(options) {
  const { decimal } = options;
  return decimal && decimal !== '.'
    ? parseNumber.map(f => s => f(s && s.replace(decimal, '.')))
    : parseNumber;
}

function valueParser(values, options) {
  const types = [parseBoolean, numberParser(options), parseDate];
  const n = types.length;
  for (let i = 0; i < n; ++i) {
    const [test, parser] = types[i];
    if (check$1(values, test)) {
      return parser;
    }
  }
  return identity;
}

function check$1(values, test) {
  const n = values.length;
  for (let i = 0; i < n; ++i) {
    const v = values[i];
    if (v != null && !test(v)) {
      return false;
    }
  }
  return true;
}

function defaultNames(n, off = 0) {
  return repeat(n - off, i => `col${i + off + 1}`);
}

function fromTextRows(next, names, options) {
  let row = next();
  const n = row.length;
  const automax = +options.autoMax || 1000;
  const values = repeat(n, () => []);
  names = names
    ? names.length < n ? [...names, defaultNames(n, names.length)] : names
    : defaultNames(n);

  // read in initial rows to guess types
  let idx = 0;
  for (; idx < automax && row; ++idx, row = next()) {
    for (let i = 0; i < n; ++i) {
      values[i].push(row[i] === '' ? null : row[i]);
    }
  }

  // initialize parsers
  const parsers = getParsers(names, values, options);

  // apply parsers
  parsers.forEach((parse, i) => {
    if (parse === identity) return;
    const v = values[i];
    for (let r = 0; r < idx; ++r) {
      if (v[r] != null) v[r] = parse(v[r]);
    }
  });

  // parse remainder of file
  for (; row; row = next()) {
    for (let i = 0; i < n; ++i) {
      values[i].push(row[i] ? parsers[i](row[i]) : null);
    }
  }

  const columns = {};
  names.forEach((name, i) => columns[name] = values[i]);
  return new ColumnTable(columns, names);
}

function getParsers(names, values, options) {
  const { parse = {} } = options;
  const noParse = options.autoType === false;

  return names.map(
    (name, i) => isFunction(parse[name]) ? parse[name]
      : noParse ? identity
      : valueParser(values[i], options)
  );
}

const EOL = {};
const EOF = {};
const QUOTE = 34;
const NEWLINE = 10;
const RETURN = 13;

function filter(read, skip, drop) {
  // skip initial lines, if requested
  let s = +skip || 0;
  while (--s >= 0) read();

  // return filtered stream
  return drop ? () => {
    let line;
    while (!line) {
      if (drop(line = read())) line = null;
      else return line;
    }
  } : read;
}

// Adapted from d3-dsv: https://github.com/d3/d3-dsv/blob/master/src/dsv.js
// Copyright 2013-2016 Mike Bostock
// All rights reserved.
// Redistribution and use in source and binary forms, with or without modification,
// are permitted provided that the following conditions are met:
// * Redistributions of source code must retain the above copyright notice, this
//   list of conditions and the following disclaimer.
// * Redistributions in binary form must reproduce the above copyright notice,
//   this list of conditions and the following disclaimer in the documentation
//   and/or other materials provided with the distribution.
// * Neither the name of the author nor the names of contributors may be used to
//   endorse or promote products derived from this software without specific prior
//   written permission.
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
// ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
// ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

function parseDelimited(text, { delimiter = ',', skip, comment }) {
  if (delimiter.length !== 1) {
    error(`Text "delimiter" should be a single character, found "${delimiter}"`);
  }
  const delimCode = delimiter.charCodeAt(0);

  let N = text.length;
  let I = 0; // current character index
  let t; // current token
  let eof = N <= 0; // current token followed by EOF?
  let eol = false; // current token followed by EOL?

  // Strip the trailing newline.
  if (text.charCodeAt(N - 1) === NEWLINE) --N;
  if (text.charCodeAt(N - 1) === RETURN) --N;

  function token() {
    if (eof) return EOF;
    if (eol) return eol = false, EOL;

    // Unescape quotes.
    const j = I;
    let i, c;
    if (text.charCodeAt(j) === QUOTE) {
      while (I++ < N && text.charCodeAt(I) !== QUOTE || text.charCodeAt(++I) === QUOTE);
      if ((i = I) >= N) eof = true;
      else if ((c = text.charCodeAt(I++)) === NEWLINE) eol = true;
      else if (c === RETURN) { eol = true; if (text.charCodeAt(I) === NEWLINE) ++I; }
      return text.slice(j + 1, i - 1).replace(/""/g, '"');
    }

    // Find next delimiter or newline.
    while (I < N) {
      if ((c = text.charCodeAt(i = I++)) === NEWLINE) eol = true;
      else if (c === RETURN) { eol = true; if (text.charCodeAt(I) === NEWLINE) ++I; }
      else if (c !== delimCode) continue;
      return text.slice(j, i);
    }

    // Return last token before EOF.
    return eof = true, text.slice(j, N);
  }

  function next() {
    if ((t = token()) !== EOF) {
      const row = [];
      while (t !== EOL && t !== EOF) row.push(t), t = token();
      return row;
    }
  }

  return filter(
    next, skip,
    comment && (x => (x && x[0] || '').startsWith(comment))
  );
}

/**
 * Options for CSV parsing.
 * @typedef {object} CSVParseOptions
 * @property {string} [delimiter=','] Single-character delimiter between values.
 * @property {string} [decimal='.'] Single-character numeric decimal separator.
 * @property {boolean} [header=true] Flag to specify presence of header row.
 *  If true, assumes the CSV contains a header row with column names. If false,
 *  indicates the CSV does not contain a header row; columns are given the
 *  names 'col1', 'col2', etc unless the *names* option is specified.
 * @property {string[]} [names] An array of column names to use for header-less
 *  CSV files. This option is ignored if the header option is true.
 * @property {number} [skip=0] The number of lines to skip before reading data.
 * @property {string} [comment] A string used to identify comment lines. Any
 *  lines that start with the comment pattern are skipped.
 * @property {boolean} [autoType=true] Flag for automatic type inference.
 * @property {number} [autoMax=1000] Maximum number of initial values to use
 *  for type inference.
 * @property {Object.<string, (value: string) => any>} [parse] Object of
 *  column parsing options. The object keys should be column names. The object
 *  values should be parsing functions that transform values upon input.
 */

/**
 * Parse a comma-separated values (CSV) string into a table. Other
 * delimiters, such as tabs or pipes ('|'), can be specified using
 * the options argument. By default, automatic type inference is performed
 * for input values; string values that match the ISO standard
 * date format are parsed into JavaScript Date objects. To disable this
 * behavior, set the autoType option to false. To perform custom parsing
 * of input column values, use the parse option.
 * @param {string} text A string in a delimited-value format.
 * @param {CSVParseOptions} options The formatting options.
 * @return {ColumnTable} A new table containing the parsed values.
 */
function fromCSV(text, options = {}) {
  const next = parseDelimited(text, options);
  return fromTextRows(
    next,
    options.header !== false ? next() : options.names,
    options
  );
}

function parseLines(text, { skip, comment }) {
  let N = text.length;
  let I = 0; // current character index

  // Strip the trailing newline.
  if (text.charCodeAt(N - 1) === NEWLINE) --N;
  if (text.charCodeAt(N - 1) === RETURN) --N;

  function read() {
    if (I >= N) return;

    const j = I;
    let eol = false;
    let i, c;

    // Find next newline.
    while (I < N) {
      if ((c = text.charCodeAt(i = I++)) === NEWLINE) eol = true;
      else if (c === RETURN) { eol = true; if (text.charCodeAt(I) === NEWLINE) ++I; }
      if (eol) return text.slice(j, i);
    }

    // Return last line before EOF.
    return text.slice(j, N);
  }

  return filter(
    read, skip,
    comment && (x => (x || '').startsWith(comment))
  );
}

/**
 * Options for fixed width file parsing.
 * @typedef {object} FixedParseOptions
 * @property {[number, number][]} [positions] Array of start, end indices for
 *  fixed-width columns.
 * @property {number[]} [widths] Array of fixed column widths. This option is
 *  ignored if the positions property is specified.
 * @property {string[]} [names] An array of column names. The array length
 *  should match the length of the positions array. If not specified or
 *  shorter than the positions array, default column names are generated.
 * @property {string} [decimal='.'] Single-character numeric decimal separator.
 * @property {number} [skip=0] The number of lines to skip before reading data.
 * @property {string} [comment] A string used to identify comment lines. Any
 *  lines that start with the comment pattern are skipped.
 * @property {boolean} [autoType=true] Flag for automatic type inference.
 * @property {number} [autoMax=1000] Maximum number of initial values to use
 *  for type inference.
 * @property {Object.<string, (value: string) => any>} [parse] Object of
 *  column parsing options. The object keys should be column names. The object
 *  values should be parsing functions that transform values upon input.
 */

/**
 * Parse a fixed-width file (FWF) string into a table. By default, automatic
 * type inference is performed for input values; string values that match the
 * ISO standard date format are parsed into JavaScript Date objects. To
 * disable this behavior, set the autoType option to false. To perform custom
 * parsing of input column values, use the parse option.
 * @param {string} text A string in a fixed-width file format.
 * @param {FixedParseOptions} options The formatting options.
 * @return {ColumnTable} A new table containing the parsed values.
 */
function fromFixed(text, options = {}) {
  const read = parseLines(text, options);
  const p = positions(options);
  return fromTextRows(
    () => {
      const line = read();
      if (line) {
        return p.map(([i, j]) => line.slice(i, j).trim());
      }
    },
    options.names,
    options
  );
}

function positions({ positions, widths }) {
  if (!positions && !widths) {
    error('Fixed width files require a "positions" or "widths" option');
  }
  let i = 0;
  return positions || widths.map(w => [i, i += w]);
}

function isDigitString(value) {
  const n = value.length;
  for (let i = 0; i < n; ++i) {
    const c = value.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/**
 * Options for JSON parsing.
 * @typedef {object} JSONParseOptions
 * @property {boolean} [autoType=true] Flag controlling automatic type
 *  inference. If false, date parsing for input JSON strings is disabled.
 * @property {Object.<string, (value: any) => any>} [parse] Object of column
 *  parsing options. The object keys should be column names. The object values
 *  should be parsing functions that transform values upon input.
 */

/**
 * Parse JavaScript Object Notation (JSON) data into a table.
 * The expected JSON data format is an object with column names for keys
 * and column value arrays for values. By default string values that match
 * the ISO standard date format are parsed into JavaScript Date objects.
 * To disable this behavior, set the autoType option to false. To perform
 * custom parsing of input column values, use the parse option. Auto-type
 * parsing is not performed for columns with custom parse options.
 * The data payload can also be provided as the "data" property of an
 * enclosing object, with an optional "schema" property containing table
 * metadata such as a "fields" array of ordered column information.
 * @param {string|object} data A string in JSON format, or pre-parsed object.
 * @param {JSONParseOptions} options The formatting options.
 * @return {ColumnTable} A new table containing the parsed values.
 */
function fromJSON(json, options = {}) {
  const autoType = defaultTrue(options.autoType);

  // parse string input
  if (isString(json)) {
    json = JSON.parse(json);
  }

  // separate schema and data, as needed
  let data = json.data, names;
  if (isObject(data) && !isArrayType(data)) {
    if (json.schema && json.schema.fields) {
      names = json.schema.fields.map(f => f.name);
    }
  } else {
    data = json;
  }

  // parse values as necessary
  if (autoType || options.parse) {
    const parsers = options.parse || {};
    for (const name in data) {
      const col = data[name];
      const len = col.length;
      if (parsers[name]) {
        // apply custom parser
        for (let i = 0; i < len; ++i) {
          col[i] = parsers[name](col[i]);
        }
      } else if (autoType) {
        // apply autoType parser
        for (let i = 0; i < len; ++i) {
          const val = col[i];
          if (isString(val) && isISODateString(val) && !isDigitString(val)) {
            col[i] = new Date(val);
          }
        }
      }
    }
  }

  return new ColumnTable(data, names);
}

function __dedupe(table, keys = []) {
  return table
    .groupby(keys.length ? keys : table.columnNames())
    .filter('row_number() === 1')
    .ungroup()
    .reify();
}

function _select(table, columns) {
  const cols = columnSet();

  columns.forEach((value, curr) => {
    const next = isString(value) ? value : curr;
    if (next) {
      const col = table.column(curr) || error(`Unrecognized column: ${curr}`);
      cols.add(next, col);
    }
  });

  return table.create(cols);
}

function __relocate(table, columns, { before, after } = {}) {
  const bef = before != null;
  const aft = after != null;

  if (!(bef || aft)) {
    error('relocate requires a before or after option.');
  }
  if (bef && aft) {
    error('relocate accepts only one of the before or after options.');
  }

  columns = resolve(table, columns);
  const anchors = [...resolve(table, bef ? before : after).keys()];
  const anchor = bef ? anchors[0] : anchors.pop();
  const select = new Map();

  // marshal inputs to select in desired order
  table.columnNames().forEach(name => {
    // check if we should assign the current column
    const assign = !columns.has(name);

    // at anchor column, insert relocated columns
    if (name === anchor) {
      if (aft && assign) select.set(name, name);
      for (const [key, value] of columns) {
        select.set(key, value);
      }
      if (aft) return; // exit if current column has been handled
    }

    if (assign) select.set(name, name);
  });

  return _select(table, select);
}

function concat(list, fn = (x => x), delim = '') {
  const n = list.length;
  if (!n) return '';

  let s = fn(list[0], 0);
  for (let i = 1; i < n; ++i) {
    s += delim + fn(list[i], i);
  }

  return s;
}

function ascending(a, b) {
  return a < b ? -1 : a > b ? 1 : a >= b ? 0 : NaN;
}

function min(values, start = 0, stop = values.length) {
  let min = stop ? values[start++] : NULL;

  for (let i = start; i < stop; ++i) {
    if (min > values[i]) {
      min = values[i];
    }
  }

  return min;
}

function max(values, start = 0, stop = values.length) {
  let max = stop ? values[start++] : NULL;

  for (let i = start; i < stop; ++i) {
    if (max < values[i]) {
      max = values[i];
    }
  }

  return max;
}

function toNumeric(value) {
  return isBigInt(value) ? value : +value;
}

function quantile(values, p) {
  const n = values.length;

  if (!n) return NULL;
  if ((p = +p) <= 0 || n < 2) return toNumeric(values[0]);
  if (p >= 1) return toNumeric(values[n - 1]);

  const i = (n - 1) * p;
  const i0 = Math.floor(i);
  const v0 = toNumeric(values[i0]);
  return isBigInt(v0)
    ? v0
    : v0 + (toNumeric(values[i0 + 1]) - v0) * (i - i0);
}

class ValueList {
  constructor(values) {
    this._values = values || [];
    this._sorted = null;
    this._start = 0;
  }

  values(copy) {
    if (this._start) {
      this._values = this._values.slice(this._start);
      this._start = 0;
    }
    return copy
      ? this._values.slice()
      : this._values;
  }

  add(value) {
    this._values.push(value);
    this._sorted = null;
  }

  rem() {
    this._start += 1;
    this._sorted = null;
  }

  min() {
    return this._sorted && this._sorted.length
      ? this._sorted[0]
      : min(this._values, this._start);
  }

  max() {
    return this._sorted && this._sorted.length
      ? this._sorted[this._sorted.length - 1]
      : max(this._values, this._start);
  }

  quantile(p) {
    if (!this._sorted) {
      this._sorted = this.values(true);
      this._sorted.sort(ascending);
    }
    return quantile(this._sorted, p);
  }
}

const update = (ops, args, fn) => unroll(
  args,
  '{' + concat(ops, (_, i) => `_${i}.${fn}(${args});`) + '}',
  ops
);

function fieldReducer(oplist, stream) {
  const { ops, output } = expand$1(oplist, stream);
  const fields = oplist[0].fields;
  const n = fields.length;
  const cls = n === 0 ? FieldReducer
    : n === 1 ? Field1Reducer
    : n === 2 ? Field2Reducer
    : error('Unsupported field count: ' + n);
  return new cls(fields, ops, output, stream);
}

function expand$1(oplist, stream) {
  const has = {};
  const ops = [];

  function add(name, params = []) {
    // check key
    const key = name + ':' + params;
    if (has[key]) return has[key];

    // get op instance
    const def = getAggregate(name);
    const op = def.create(...params);

    // add required dependencies
    if (stream < 0 && def.stream) {
      def.stream.forEach(name => add(name, []));
    }
    if (def.req) {
      def.req.forEach(name => add(name, []));
    }

    // update state
    has[key] = op;
    ops.push(op);

    return op;
  }

  const output = oplist.map(item => {
    const op = add(item.name, item.params);
    op.output = item.id;
    return op;
  });

  return { ops, output };
}

class FieldReducer extends Reducer {
  constructor(fields, ops, outputs, stream) {
    super(outputs);
    this._op = ops;
    this._fields = fields;
    this._stream = !!stream;
  }

  init() {
    const state = { count: 0, valid: 0, stream: this._stream };
    this._op.forEach(op => op.init(state));

    // value list requested
    if (state.values) {
      state.list = new ValueList();
    }

    return state;
  }

  write(state, values, index) {
    const op = this._outputs;
    const n = op.length;
    for (let i = 0; i < n; ++i) {
      values[op[i].output][index] = op[i].value(state);
    }
    return 1;
  }

  _add() {
  }

  _rem() {
  }

  add(state) {
    ++state.count;
  }

  rem(state) {
    --state.count;
  }
}

class Field1Reducer extends FieldReducer {
  constructor(fields, ops, outputs, stream) {
    super(fields, ops, outputs, stream);

    // unroll op invocations for performance
    const args = ['state', 'v1', 'v2'];
    this._add = update(ops, args, 'add');
    this._rem = update(ops, args, 'rem');
  }

  add(state, row, data) {
    const value = this._fields[0](row, data);
    ++state.count;
    if (isValid(value)) {
      ++state.valid;
      if (state.list) state.list.add(value);
      this._add(state, value);
    }
  }

  rem(state, row, data) {
    const value = this._fields[0](row, data);
    --state.count;
    if (isValid(value)) {
      --state.valid;
      if (state.list) state.list.rem();
      this._rem(state, value);
    }
  }
}

class Field2Reducer extends FieldReducer {
  constructor(fields, ops, outputs, stream) {
    super(fields, ops, outputs, stream);

    // unroll op invocations for performance
    const args = ['state', 'v1', 'v2'];
    this._add = update(ops, args, 'add');
    this._rem = update(ops, args, 'rem');
  }

  add(state, row, data) {
    const value1 = this._fields[0](row, data);
    const value2 = this._fields[1](row, data);
    ++state.count;
    if (isValid(value1) && isValid(value2)) {
      ++state.valid;
      if (state.list) state.list.add([value1, value2]);
      this._add(state, value1, value2);
    }
  }

  rem(state, row, data) {
    const value1 = this._fields[0](row, data);
    const value2 = this._fields[1](row, data);
    --state.count;
    if (isValid(value1) && isValid(value2)) {
      --state.valid;
      if (state.list) state.list.rem();
      this._rem(state, value1, value2);
    }
  }
}

function aggregateGet(table, ops, get) {
  if (ops.length) {
    const data = table.data();
    const { keys } = table.groups() || {};
    const result = aggregate(table, ops);
    const op = keys
      ? (name, row) => result[name][keys[row]]
      : name => result[name][0];
    get = get.map(f => row => f(row, data, op));
  }

  return get;
}

function aggregate(table, ops, result) {
  if (!ops.length) return result; // early exit

  // instantiate aggregators and result store
  const aggrs = reducers(ops);
  const groups = table.groups();
  const size = groups ? groups.size : 1;
  result = result || repeat(ops.length, () => Array(size));

  // compute aggregates, extract results
  if (size > 1) {
    aggrs.forEach(aggr => {
      const cells = reduceGroups(table, aggr, groups);
      for (let i = 0; i < size; ++i) {
        aggr.write(cells[i], result, i);
      }
    });
  } else {
    aggrs.forEach(aggr => {
      const cell = reduceFlat(table, aggr);
      aggr.write(cell, result, 0);
    });
  }

  return result;
}

function reducers(ops, stream) {
  const aggrs = [];
  const fields = {};

  // group operators by field inputs
  for (const op of ops) {
    const key = op.fields.map(f => f + '').join(',');
    (fields[key] || (fields[key] = [])).push(op);
  }

  // generate a field reducer for each field
  for (const key in fields) {
    aggrs.push(fieldReducer(fields[key], stream));
  }

  return aggrs;
}

function reduceFlat(table, reducer) {
  // initialize aggregation cell
  const cell = reducer.init();

  // compute aggregate values
  // inline the following for performance:
  // table.scan((row, data) => reducer.add(cell, row, data));
  const n = table.totalRows();
  const data = table.data();
  const bits = table.mask();

  if (table.isOrdered()) {
    const idx = table.indices();
    for (let i = 0; i < n; ++i) {
      reducer.add(cell, idx[i], data);
    }
  } else if (bits) {
    for (let i = bits.next(0); i >= 0; i = bits.next(i + 1)) {
      reducer.add(cell, i, data);
    }
  } else {
    for (let i = 0; i < n; ++i) {
      reducer.add(cell, i, data);
    }
  }

  return cell;
}

function reduceGroups(table, reducer, groups) {
  const { keys, size } = groups;

  // initialize aggregation cells
  const cells = repeat(size, () => reducer.init());

  // compute aggregate values
  // inline the following for performance:
  // table.scan((row, data) => reducer.add(cells[keys[row]], row, data));
  const data = table.data();

  if (table.isOrdered()) {
    const idx = table.indices();
    const m = idx.length;
    for (let i = 0; i < m; ++i) {
      const row = idx[i];
      reducer.add(cells[keys[row]], row, data);
    }
  } else if (table.isFiltered()) {
    const bits = table.mask();
    for (let i = bits.next(0); i >= 0; i = bits.next(i + 1)) {
      reducer.add(cells[keys[i]], i, data);
    }
  } else {
    const n = table.totalRows();
    for (let i = 0; i < n; ++i) {
      reducer.add(cells[keys[i]], i, data);
    }
  }

  return cells;
}

function groupOutput(cols, groups) {
  const { get, names, rows, size } = groups;

  // write group values to output columns
  const m = names.length;
  for (let j = 0; j < m; ++j) {
    const col = cols.add(names[j], Array(size));
    const val = get[j];
    for (let i = 0; i < size; ++i) {
      col[i] = val(rows[i]);
    }
  }
}

function bisector(compare) {
  return {
    left(a, x, lo, hi) {
      if (lo == null) lo = 0;
      if (hi == null) hi = a.length;
      while (lo < hi) {
        const mid = lo + hi >>> 1;
        if (compare(a[mid], x) < 0) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    right(a, x, lo, hi) {
      if (lo == null) lo = 0;
      if (hi == null) hi = a.length;
      while (lo < hi) {
        const mid = lo + hi >>> 1;
        if (compare(a[mid], x) > 0) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    }
  };
}

const bisect = bisector(ascending);

function windowState(data, frame, adjust, ops, aggrs) {
  let rows, peer, cells, result, key;
  const isPeer = index => peer[index - 1] === peer[index];
  const numOps = ops.length;
  const numAgg = aggrs.length;

  const evaluate = ops.length
    ? unroll(
        ['w', 'r', 'k'],
        '{' + concat(ops, (_, i) => `r[_${i}.id][k]=_${i}.value(w,_${i}.get);`) + '}',
        ops
      )
    : () => {};

  const w = {
    i0: 0,
    i1: 0,
    index: 0,
    size: 0,
    peer: isPeer,

    init(partition, peers, results, group) {
      w.index = w.i0 = w.i1 = 0;
      w.size = peers.length;
      rows = partition;
      peer = peers;
      result = results;
      key = group;

      // initialize aggregates
      cells = aggrs ? aggrs.map(aggr => aggr.init()) : null;

      // initialize window ops
      for (let i = 0; i < numOps; ++i) {
        ops[i].init();
      }

      return w;
    },

    value(index, get) {
      return get(rows[index], data);
    },

    step(idx) {
      const [f0, f1] = frame;
      const n = w.size;
      const p0 = w.i0;
      const p1 = w.i1;

      w.i0 = f0 != null ? Math.max(0, idx - Math.abs(f0)) : 0;
      w.i1 = f1 != null ? Math.min(n, idx + Math.abs(f1) + 1) : n;
      w.index = idx;

      if (adjust) {
        if (w.i0 > 0 && isPeer(w.i0)) {
          w.i0 = bisect.left(peer, peer[w.i0]);
        }
        if (w.i1 < n && isPeer(w.i1)) {
          w.i1 = bisect.right(peer, peer[w.i1 - 1]);
        }
      }

      // evaluate aggregates
      for (let i = 0; i < numAgg; ++i) {
        const aggr = aggrs[i];
        const cell = cells[i];
        for (let j = p0; j < w.i0; ++j) {
          aggr.rem(cell, rows[j], data);
        }
        for (let j = p1; j < w.i1; ++j) {
          aggr.add(cell, rows[j], data);
        }
        aggr.write(cell, result, key);
      }

      // evaluate window ops
      evaluate(w, result, key);

      return result;
    }
  };

  return w;
}

const frameValue = op =>
  (op.frame || [null, null]).map(v => Number.isFinite(v) ? Math.abs(v) : null);

const peersValue = op => !!op.peers;

function windowOp(spec) {
  const { id, name, fields = [], params = [] } = spec;
  const op = getWindow(name).create(...params);
  if (fields.length) op.get = fields[0];
  op.id = id;
  return op;
}

function window(table, cols, exprs, result = {}, ops) {
  // instantiate window states
  const data = table.data();
  const states = windowStates(ops, data);
  const nstate = states.length;

  const write = unroll(
    ['r', 'd', 'op'],
    '{' + concat(cols, (_, i) => `_${i}[r] = $${i}(r, d, op);`) + '}',
    cols, exprs
  );

  // scan each ordered partition
  table.partitions().forEach((rows, key) => {
    const size = rows.length;
    const peers = windowPeers(table, rows);

    // initialize window states
    for (let i = 0; i < nstate; ++i) {
      states[i].init(rows, peers, result, key);
    }

    // calculate window values per-row
    const op = id => result[id][key];
    for (let index = 0; index < size; ++index) {
      // advance window frame, updates result object
      for (let i = 0; i < nstate; ++i) {
        states[i].step(index);
      }
      write(rows[index], data, op);
    }
  });
}

function windowStates(ops, data) {
  const map = {};

  // group operations by window frame parameters
  ops.forEach(op => {
    const frame = frameValue(op);
    const peers = peersValue(op);
    const key = `${frame},${peers}`;
    const { aggOps, winOps } = map[key] || (map[key] = {
      frame,
      peers,
      aggOps: [],
      winOps: []
    });
    hasAggregate(op.name)
      ? aggOps.push(op)
      : winOps.push(windowOp(op));
  });

  return Object.values(map).map(_ => windowState(
    data, _.frame, _.peers, _.winOps,
    reducers(_.aggOps, _.frame[0] != null ? -1 : 1)
  ));
}

function windowPeers(table, rows) {
  if (table.isOrdered()) {
    // generate peer ids for sort equality checking
    const compare = table.comparator();
    const data = table.data();
    const nrows = rows.length;
    const peers = new Uint32Array(nrows);
    for (let i = 1, index = 0; i < nrows; ++i) {
      peers[i] = compare(rows[i - 1], rows[i], data) ? ++index : index;
    }
    return peers;
  } else {
    // no sort, no peers: reuse row indices as peer ids
    return rows;
  }
}

function isWindowed(op) {
  return hasWindow(op.name) ||
    op.frame && (
      Number.isFinite(op.frame[0]) ||
      Number.isFinite(op.frame[1])
    );
}

function _derive(table, { names, exprs, ops }, options = {}) {
  // instantiate output data
  const total = table.totalRows();
  const cols = columnSet(options.drop ? null : table);
  const data = names.map(name => cols.add(name, Array(total)));

  // analyze operations, compute non-windowed aggregates
  const [ aggOps, winOps ] = segmentOps(ops);

  const size = table.isGrouped() ? table.groups().size : 1;
  const result = aggregate(
    table, aggOps,
    repeat(ops.length, () => Array(size))
  );

  // perform table scans to generate output values
  winOps.length
    ? window(table, data, exprs, result, winOps)
    : output$2(table, data, exprs, result);

  return table.create(cols);
}

function segmentOps(ops) {
  const aggOps = [];
  const winOps = [];
  const n = ops.length;

  for (let i = 0; i < n; ++i) {
    const op = ops[i];
    op.id = i;
    (isWindowed(op) ? winOps : aggOps).push(op);
  }

  return [aggOps, winOps];
}

function output$2(table, cols, exprs, result) {
  const bits = table.mask();
  const data = table.data();
  const { keys } = table.groups() || {};
  const op = keys
    ? (id, row) => result[id][keys[row]]
    : id => result[id][0];

  const m = cols.length;
  for (let j = 0; j < m; ++j) {
    const get = exprs[j];
    const col = cols[j];

    // inline the following for performance:
    // table.scan((i, data) => col[i] = get(i, data, op));
    if (bits) {
      for (let i = bits.next(0); i >= 0; i = bits.next(i + 1)) {
        col[i] = get(i, data, op);
      }
    } else {
      const n = table.totalRows();
      for (let i = 0; i < n; ++i) {
        col[i] = get(i, data, op);
      }
    }
  }
}

function __derive(table, values, options = {}) {
  const dt = _derive(table, parse$2(values, { table }), options);

  return options.drop || (options.before == null && options.after == null)
    ? dt
    : __relocate(dt,
        Object.keys(values).filter(name => !table.column(name)),
        options
      );
}

function __except(table, others) {
  if (others.length === 0) return table;
  const names = table.columnNames();
  return others.reduce((a, b) => a.antijoin(b.select(names)), table).dedupe();
}

const ONE = 0x80000000;
const ALL = 0xFFFFFFFF;

/**
 * Represent an indexable set of bits.
 */
class BitSet {
  /**
   * Instantiate a new BitSet instance.
   * @param {number} size The number of bits.
   */
  constructor(size) {
    this._size = size;
    this._bits = new Uint32Array(Math.ceil(size / 32));
  }

  /**
   * The number of bits.
   * @return {number}
   */
  get length() {
    return this._size;
  }

  /**
   * The number of bits set to one.
   * https://graphics.stanford.edu/~seander/bithacks.html#CountBitsSetKernighan
   * @return {number}
   */
  count() {
    const n = this._bits.length;
    let count = 0;
    for (let i = 0; i < n; ++i) {
      for (let b = this._bits[i]; b; ++count) {
        b &= b - 1;
      }
    }
    return count;
  }

  /**
   * Get the bit at a given index.
   * @param {number} i The bit index.
   */
  get(i) {
    return this._bits[i >> 5] & (ONE >>> i);
  }

  /**
   * Set the bit at a given index to one.
   * @param {number} i The bit index.
   */
  set(i) {
    this._bits[i >> 5] |= (ONE >>> i);
  }

  /**
   * Clear the bit at a given index to zero.
   * @param {number} i The bit index.
   */
  clear(i) {
    this._bits[i >> 5] &= ~(ONE >>> i);
  }

  /**
   * Scan the bits, invoking a callback function with the index of
   * each non-zero bit.
   * @param {(i: number) => void} fn A callback function.
   */
  scan(fn) {
    for (let i = this.next(0); i >= 0; i = this.next(i + 1)) {
      fn(i);
    }
  }

  /**
   * Get the next non-zero bit starting from a given index.
   * @param {number} i The bit index.
   */
  next(i) {
    const bits = this._bits;
    const n = bits.length;

    let index = i >> 5;
    let curr = bits[index] & (ALL >>> i);

    for (; index < n; curr = bits[++index]) {
      if (curr !== 0) {
        return (index << 5) + Math.clz32(curr);
      }
    }

    return -1;
  }

  /**
   * Return the index of the nth non-zero bit.
   * @param {number} n The number of non-zero bits to advance.
   * @return {number} The index of the nth non-zero bit.
   */
  nth(n) {
    let i = this.next(0);
    while (n-- && i >= 0) i = this.next(i + 1);
    return i;
  }

  /**
   * Negate all bits in this bitset.
   * Modifies this BitSet in place.
   * @return {this}
   */
  not() {
    const bits = this._bits;
    const n = bits.length;

    // invert all bits
    for (let i = 0; i < n; ++i) {
      bits[i] = ~bits[i];
    }

    // unset extraneous trailing bits
    const tail = this._size % 32;
    if (tail) {
      bits[n - 1] &= ONE >> (tail - 1);
    }

    return this;
  }

  /**
   * Compute the logical AND of this BitSet and another.
   * @param {BitSet} bitset The BitSet to combine with.
   * @return {BitSet} This BitSet updated with the logical AND.
   */
  and(bitset) {
    if (bitset) {
      const a = this._bits;
      const b = bitset._bits;
      const n = a.length;

      for (let i = 0; i < n; ++i) {
        a[i] &= b[i];
      }
    }
    return this;
  }

  /**
   * Compute the logical OR of this BitSet and another.
   * @param {BitSet} bitset The BitSet to combine with.
   * @return {BitSet} This BitSet updated with the logical OR.
   */
  or(bitset) {
    if (bitset) {
      const a = this._bits;
      const b = bitset._bits;
      const n = a.length;

      for (let i = 0; i < n; ++i) {
        a[i] |= b[i];
      }
    }
    return this;
  }
}

function _filter(table, predicate) {
  const n = table.totalRows();
  const bits = table.mask();
  const data = table.data();
  const filter = new BitSet(n);

  // inline the following for performance:
  // table.scan((row, data) => { if (predicate(row, data)) filter.set(row); });
  if (bits) {
    for (let i = bits.next(0); i >= 0; i = bits.next(i + 1)) {
      if (predicate(i, data)) filter.set(i);
    }
  } else {
    for (let i = 0; i < n; ++i) {
      if (predicate(i, data)) filter.set(i);
    }
  }

  return table.create({ filter });
}

function __filter(table, criteria) {
  const test = parse$2({ p: criteria }, { table });
  let predicate = test.exprs[0];
  if (test.ops.length) {
    const { data } = _derive(table, test, { drop: true }).column('p');
    predicate = row => data[row];
  }
  return _filter(table, predicate);
}

function _unroll(table, { names = [], exprs = [], ops = [] }, options = {}) {
  if (!names.length) return table;

  const limit = options.limit > 0 ? +options.limit : Infinity;
  const index = options.index
    ? options.index === true ? 'index' : options.index + ''
    : null;
  const drop = new Set(options.drop);
  const get = aggregateGet(table, ops, exprs);

  // initialize output columns
  const cols = columnSet();
  const nset = new Set(names);
  const priors = [];
  const copies = [];
  const unroll = [];

  // original and copied columns
  table.columnNames().forEach(name => {
    if (!drop.has(name)) {
      const col = cols.add(name, []);
      if (!nset.has(name)) {
        priors.push(table.column(name));
        copies.push(col);
      }
    }
  });

  // unrolled output columns
  names.forEach(name => {
    if (!drop.has(name)) {
      if (!cols.has(name)) cols.add(name, []);
      unroll.push(cols.data[name]);
    }
  });

  // index column, if requested
  const icol = index ? cols.add(index, []) : null;

  let start = 0;
  const m = priors.length;
  const n = unroll.length;

  const copy = (row, maxlen) => {
    for (let i = 0; i < m; ++i) {
      copies[i].length = start + maxlen;
      copies[i].fill(priors[i].get(row), start, start + maxlen);
    }
  };

  const indices = icol
    ? (row, maxlen) => {
        for (let i = 0; i < maxlen; ++i) {
          icol[row + i] = i;
        }
      }
    : () => {};

  if (n === 1) {
    // optimize common case of one array-valued column
    const fn = get[0];
    const col = unroll[0];

    table.scan((row, data) => {
      // extract array data
      const array = toArray(fn(row, data));
      const maxlen = Math.min(array.length, limit);

      // copy original table data
      copy(row, maxlen);

      // copy unrolled array data
      for (let j = 0; j < maxlen; ++j) {
        col[start + j] = array[j];
      }

      // fill in array indices
      indices(start, maxlen);

      start += maxlen;
    });
  } else {
    table.scan((row, data) => {
      let maxlen = 0;

      // extract parallel array data
      const arrays = get.map(fn => {
        const value = toArray(fn(row, data));
        maxlen = Math.min(Math.max(maxlen, value.length), limit);
        return value;
      });

      // copy original table data
      copy(row, maxlen);

      // copy unrolled array data
      for (let i = 0; i < n; ++i) {
        const col = unroll[i];
        const arr = arrays[i];
        for (let j = 0; j < maxlen; ++j) {
          col[start + j] = arr[j];
        }
      }

      // fill in array indices
      indices(start, maxlen);

      start += maxlen;
    });
  }

  return table.create(cols.new());
}

function _fold(table, { names = [], exprs = [], ops = [] }, options = {}) {
  if (names.length === 0) return table;

  const [k = 'key', v = 'value'] = options.as || [];
  const vals = aggregateGet(table, ops, exprs);

  return _unroll(
    table,
    {
      names: [k, v],
      exprs: [() => names, (row, data) => vals.map(fn => fn(row, data))]
    },
    { ...options, drop: names }
  );
}

function parse$1(name, table, params, options = { window: false }) {
  const exprs = new Map();

  const marshal = param => {
    param = isNumber(param) ? table.columnName(param) : param;
    isString(param) ? exprs.set(param, field(param))
      : isFunction(param) ? resolve(table, param).forEach(marshal)
      : isObject(param) ? assign(exprs, param)
      : error(`Invalid ${name} value: ${param+''}`);
  };

  toArray(params).forEach(marshal);

  if (options.preparse) {
    options.preparse(exprs);
  }

  return parse$2(exprs, { table, ...options });
}

function __fold(table, values, options) {
  return _fold(table, parse$1('fold', table, values), options);
}

function _impute(table, values, keys, arrays) {
  const write = keys && keys.length;
  return impute(
    write ? expand(table, keys, arrays) : table,
    values,
    write
  );
}

function impute(table, { names, exprs, ops }, write) {
  const gets = aggregateGet(table, ops, exprs);
  const cols = write ? null : columnSet(table);
  const rows = table.totalRows();

  names.forEach((name, i) => {
    const col = table.column(name);
    const out = write ? col.data : cols.add(name, Array(rows));
    const get = gets[i];

    table.scan(idx => {
      const v = col.get(idx);
      out[idx] = !isValid(v) ? get(idx) : v;
    });
  });

  return write ? table : table.create(cols);
}

function expand(table, keys, values) {
  const groups = table.groups();
  const data = table.data();

  // expansion keys and accessors
  const keyNames = (groups ? groups.names : []).concat(keys);
  const keyGet = (groups ? groups.get : [])
    .concat(keys.map(key => table.getter(key)));

  // build hash of existing rows
  const hash = new Set();
  const keyTable = keyFunction(keyGet);
  table.scan((idx, data) => hash.add(keyTable(idx, data)));

  // initialize output table data
  const names = table.columnNames();
  const cols = columnSet();
  const out = names.map(name => cols.add(name, []));
  names.forEach((name, i) => {
    const old = data[name];
    const col = out[i];
    table.scan(row => col.push(old.get(row)));
  });

  // enumerate expanded value sets and augment output table
  const keyEnum = keyFunction(keyGet.map((k, i) => a => a[i]));
  const set = unroll(
    'v',
    '{' + out.map((_, i) => `_${i}.push(v[$${i}]);`).join('') + '}',
    out, names.map(name => keyNames.indexOf(name))
  );

  if (groups) {
    let row = groups.keys.length;
    const prod = values.reduce((p, a) => p * a.length, groups.size);
    const keys = new Uint32Array(prod + (row - hash.size));
    keys.set(groups.keys);
    enumerate(groups, values, (vec, idx) => {
      if (!hash.has(keyEnum(vec))) {
        set(vec);
        keys[row++] = idx[0];
      }
    });
    cols.groupby({ ...groups, keys });
  } else {
    enumerate(groups, values, vec => {
      if (!hash.has(keyEnum(vec))) set(vec);
    });
  }

  return table.create(cols.new());
}

function enumerate(groups, values, callback) {
  const offset = groups ? groups.get.length : 0;
  const pad = groups ? 1 : 0;
  const len = pad + values.length;
  const lens = new Int32Array(len);
  const idxs = new Int32Array(len);
  const set = [];

  if (groups) {
    const { get, rows, size } = groups;
    lens[0] = size;
    set.push((vec, idx) => {
      const row = rows[idx];
      for (let i = 0; i < offset; ++i) {
        vec[i] = get[i](row);
      }
    });
  }

  values.forEach((a, i) => {
    const j = i + offset;
    lens[i + pad] = a.length;
    set.push((vec, idx) => vec[j] = a[idx]);
  });

  const vec = Array(offset + values.length);

  // initialize value vector
  for (let i = 0; i < len; ++i) {
    set[i](vec, 0);
  }
  callback(vec, idxs);

  // enumerate all combinations of values
  for (let i = len - 1; i >= 0;) {
    const idx = ++idxs[i];
    if (idx < lens[i]) {
      set[i](vec, idx);
      callback(vec, idxs);
      i = len - 1;
    } else {
      idxs[i] = 0;
      set[i](vec, 0);
      --i;
    }
  }
}

function _rollup(table, { names, exprs, ops }) {
  // output data
  const cols = columnSet();
  const groups = table.groups();

  // write groupby fields to output
  if (groups) groupOutput(cols, groups);

  // compute and write aggregate output
  output$1(names, exprs, groups, aggregate(table, ops), cols);

  // return output table
  return table.create(cols.new());
}

function output$1(names, exprs, groups, result = [], cols) {
  if (!exprs.length) return;
  const size = groups ? groups.size : 1;
  const op = (id, row) => result[id][row];
  const n = names.length;

  for (let i = 0; i < n; ++i) {
    const get = exprs[i];
    if (get.field != null) {
      // if expression is op only, use aggregates directly
      cols.add(names[i], result[get.field]);
    } else if (size > 1) {
      // if multiple groups, evaluate expression for each
      const col = cols.add(names[i], Array(size));
      for (let j = 0; j < size; ++j) {
        col[j] = get(j, null, op);
      }
    } else {
      // if only one group, no need to loop
      cols.add(names[i], [ get(0, null, op) ]);
    }
  }
}

function __impute(table, values, options = {}) {
  values = parse$2(values, { table });

  values.names.forEach(name =>
    table.column(name) ? 0 : error(`Invalid impute column ${toString(name)}`)
  );

  if (options.expand) {
    const opt = { preparse: preparse$1, aggronly: true };
    const params = parse$1('impute', table, options.expand, opt);
    const result = _rollup(table.ungroup(), params);
    return _impute(
      table, values, params.names,
      params.names.map(name => result.get(name, 0))
    );
  } else {
    return _impute(table, values);
  }
}

// map direct field reference to "unique" aggregate
function preparse$1(map) {
  map.forEach((value, key) =>
    value.field ? map.set(key, array_agg_distinct(value + '')) : 0
  );
}

function __intersect(table, others) {
  const names = table.columnNames();
  return others.length
    ? others.reduce((a, b) => a.semijoin(b.select(names)), table).dedupe()
    : table.reify([]);
}

function rowLookup(table, hash) {
  const lut = new Map();
  table.scan((row, data) => {
    const key = hash(row, data);
    if (key != null && key === key) {
      lut.set(key, row);
    }
  });
  return lut;
}

function indexLookup(idx, data, hash) {
  const lut = new Map();
  const n = idx.length;
  for (let i = 0; i < n; ++i) {
    const row = idx[i];
    const key = hash(row, data);
    if (key != null && key === key) {
      lut.has(key)
        ? lut.get(key).push(i)
        : lut.set(key, [i]);
    }
  }
  return lut;
}

function emitter(columns, getters) {
  const args = ['i', 'a', 'j', 'b'];
  return unroll(
    args,
    '{' + concat(columns, (_, i) => `_${i}.push($${i}(${args}));`) + '}',
    columns, getters
  );
}

function _join(tableL, tableR, predicate, { names, exprs }, options = {}) {
  // initialize data for left table
  const dataL = tableL.data();
  const idxL = tableL.indices(false);
  const nL = idxL.length;
  const hitL = new Int32Array(nL);

  // initialize data for right table
  const dataR = tableR.data();
  const idxR = tableR.indices(false);
  const nR = idxR.length;
  const hitR = new Int32Array(nR);

  // initialize output data
  const ncols = names.length;
  const cols = columnSet();
  const columns = Array(ncols);
  const getters = Array(ncols);
  for (let i = 0; i < names.length; ++i) {
    columns[i] = cols.add(names[i], []);
    getters[i] = exprs[i];
  }
  const emit = emitter(columns, getters);

  // perform join
  const join = isArray(predicate) ? hashJoin : loopJoin;
  join(emit, predicate, dataL, dataR, idxL, idxR, hitL, hitR, nL, nR);

  if (options.left) {
    for (let i = 0; i < nL; ++i) {
      if (!hitL[i]) {
        emit(idxL[i], dataL, -1, dataR);
      }
    }
  }

  if (options.right) {
    for (let j = 0; j < nR; ++j) {
      if (!hitR[j]) {
        emit(-1, dataL, idxR[j], dataR);
      }
    }
  }

  return tableL.create(cols.new());
}

function loopJoin(emit, predicate, dataL, dataR, idxL, idxR, hitL, hitR, nL, nR) {
  // perform nested-loops join
  for (let i = 0; i < nL; ++i) {
    const rowL = idxL[i];
    for (let j = 0; j < nR; ++j) {
      const rowR = idxR[j];
      if (predicate(rowL, dataL, rowR, dataR)) {
        emit(rowL, dataL, rowR, dataR);
        hitL[i] = 1;
        hitR[j] = 1;
      }
    }
  }
}

function hashJoin(emit, [keyL, keyR], dataL, dataR, idxL, idxR, hitL, hitR, nL, nR) {
  // determine which table to hash
  let dataScan, keyScan, hitScan, idxScan;
  let dataHash, keyHash, hitHash, idxHash;
  let emitScan = emit;
  if (nL >= nR) {
    dataScan = dataL; keyScan = keyL; hitScan = hitL; idxScan = idxL;
    dataHash = dataR; keyHash = keyR; hitHash = hitR; idxHash = idxR;
  } else {
    dataScan = dataR; keyScan = keyR; hitScan = hitR; idxScan = idxR;
    dataHash = dataL; keyHash = keyL; hitHash = hitL; idxHash = idxL;
    emitScan = (i, a, j, b) => emit(j, b, i, a);
  }

  // build lookup table
  const lut = indexLookup(idxHash, dataHash, keyHash);

  // scan other table
  const m = idxScan.length;
  for (let j = 0; j < m; ++j) {
    const rowScan = idxScan[j];
    const list = lut.get(keyScan(rowScan, dataScan));
    if (list) {
      const n = list.length;
      for (let k = 0; k < n; ++k) {
        const i = list[k];
        emitScan(rowScan, dataScan, idxHash[i], dataHash);
        hitHash[i] = 1;
      }
      hitScan[j] = 1;
    }
  }
}

function parseKey(name, table, params) {
  const exprs = new Map();

  toArray(params).forEach((param, i) => {
    param = isNumber(param) ? table.columnName(param) : param;
    isString(param) ? exprs.set(i, field(param))
      : isFunction(param) || isObject(param) && param.expr ? exprs.set(i, param)
      : error(`Invalid ${name} key value: ${param+''}`);
  });

  const fn = parse$2(exprs, { table, aggregate: false, window: false });
  return keyFunction(fn.exprs, true);
}

function intersect(a, b) {
  const set = new Set(b);
  return a.filter(x => set.has(x));
}

function inferKeys(tableL, tableR, on) {
  if (!on) {
    // perform natural join if join condition not provided
    const isect = intersect(tableL.columnNames(), tableR.columnNames());
    if (!isect.length) error('Natural join requires shared column names.');
    on = [isect, isect];
  } else if (isString(on)) {
    on = [on, on];
  } else if (isArray(on) && on.length === 1) {
    on = [on[0], on[0]];
  }

  return on;
}

function keyPredicate(tableL, tableR, onL, onR) {
  if (onL.length !== onR.length) {
    error('Mismatched number of join keys');
  }
  return [
    parseKey('join', tableL, onL),
    parseKey('join', tableR, onR)
  ];
}

const OPT_L = { aggregate: false, window: false };
const OPT_R = { ...OPT_L, index: 1 };

function __join(tableL, tableR, on, values, options = {}) {
  on = inferKeys(tableL, tableR, on);
  const optParse = { join: [tableL, tableR] };
  let predicate;

  if (isArray(on)) {
    const [onL, onR] = on.map(toArray);
    predicate = keyPredicate(tableL, tableR, onL, onR);

    if (!values) {
      // infer output columns, suppress duplicated key columns
      values = inferValues(tableL, onL, onR, options);
    }
  } else {
    predicate = parse$2({ on }, optParse).exprs[0];

    if (!values) {
      // include all table columns if values not provided
      values = [all(), all()];
    }
  }

  return _join(
    tableL, tableR, predicate,
    parseValues$1(tableL, tableR, values, optParse, options && options.suffix),
    options
  );
}

function inferValues(tableL, onL, onR, options) {
  const isect = [];
  onL.forEach((s, i) => isString(s) && s === onR[i] ? isect.push(s) : 0);
  const vR = not(isect);

  if (options.left && options.right) {
    // for full join, merge shared key columns together
    const shared = new Set(isect);
    return [
      tableL.columnNames().map(s => {
        const c = `[${toString(s)}]`;
        return shared.has(s)
          ? { [s]: `(a, b) => a${c} == null ? b${c} : a${c}` }
          : s;
      }),
      vR
    ];
  }

  return options.right ? [vR, all()] : [all(), vR];
}

function parseValues$1(tableL, tableR, values, optParse, suffix = []) {
  if (isArray(values)) {
    let vL, vR, vJ, n = values.length;
    vL = vR = vJ = { names: [], exprs: [] };

    if (n--) {
      vL = parse$1('join', tableL, values[0], optParse);
    }
    if (n--) {
      vR = parse$1('join', tableR, values[1], OPT_R);
    }
    if (n--) {
      vJ = parse$2(values[2], optParse);
    }

    // handle name collisions
    const rename = new Set();
    const namesL = new Set(vL.names);
    vR.names.forEach(name => {
      if (namesL.has(name)) {
        rename.add(name);
      }
    });
    if (rename.size) {
      suffix[0] !== '' && rekey(vL.names, rename, suffix[0] || '_1');
      suffix[1] !== '' && rekey(vR.names, rename, suffix[1] || '_2');
    }

    return {
      names: vL.names.concat(vR.names, vJ.names),
      exprs: vL.exprs.concat(vR.exprs, vJ.exprs)
    };
  } else {
    return parse$2(values, optParse);
  }
}

function rekey(names, rename, suffix) {
  names.forEach((name, i) => rename.has(name)
    ? (names[i] = name + suffix)
    : 0);
}

function _join_filter(tableL, tableR, predicate, options = {}) {
  // calculate semi-join filter mask
  const filter = new BitSet(tableL.totalRows());
  const join = isArray(predicate) ? hashSemiJoin : loopSemiJoin;
  join(filter, tableL, tableR, predicate);

  // if anti-join, negate the filter
  if (options.anti) {
    filter.not().and(tableL.mask());
  }

  return tableL.create({ filter });
}

function hashSemiJoin(filter, tableL, tableR, [keyL, keyR]) {
  // build lookup table
  const lut = rowLookup(tableR, keyR);

  // scan table, update filter with matches
  tableL.scan((rowL, data) => {
    const rowR = lut.get(keyL(rowL, data));
    if (rowR >= 0) filter.set(rowL);
  });
}

function loopSemiJoin(filter, tableL, tableR, predicate) {
  const nL = tableL.numRows();
  const nR = tableR.numRows();
  const dataL = tableL.data();
  const dataR = tableR.data();

  if (tableL.isFiltered() || tableR.isFiltered()) {
    // use indices as at least one table is filtered
    const idxL = tableL.indices(false);
    const idxR = tableR.indices(false);
    for (let i = 0; i < nL; ++i) {
      const rowL = idxL[i];
      for (let j = 0; j < nR; ++j) {
        if (predicate(rowL, dataL, idxR[j], dataR)) {
          filter.set(rowL);
          break;
        }
      }
    }
  } else {
    // no filters, enumerate row indices directly
    for (let i = 0; i < nL; ++i) {
      for (let j = 0; j < nR; ++j) {
        if (predicate(i, dataL, j, dataR)) {
          filter.set(i);
          break;
        }
      }
    }
  }
}

// export default function(tableL, tableR, predicate, options = {}) {
//   const filter = new BitSet(tableL.totalRows());
//   const nL = tableL.numRows();
//   const nR = tableR.numRows();
//   const dataL = tableL.data();
//   const dataR = tableR.data();

//   if (tableL.isFiltered() || tableR.isFiltered()) {
//     // use indices as at least one table is filtered
//     const idxL = tableL.indices(false);
//     const idxR = tableR.indices(false);
//     for (let i = 0; i < nL; ++i) {
//       const rowL = idxL[i];
//       for (let j = 0; j < nR; ++j) {
//         if (predicate(rowL, dataL, idxR[j], dataR)) {
//           filter.set(rowL);
//           break;
//         }
//       }
//     }
//   } else {
//     // no filters, enumerate row indices directly
//     for (let i = 0; i < nL; ++i) {
//       for (let j = 0; j < nR; ++j) {
//         if (predicate(i, dataL, j, dataR)) {
//           filter.set(i);
//           break;
//         }
//       }
//     }
//   }

//   // if anti-join, negate the filter
//   if (options.anti) {
//     filter.not().and(tableL.mask());
//   }

//   return tableL.create({ filter });
// }

function __semijoin(tableL, tableR, on, options) {
  on = inferKeys(tableL, tableR, on);

  const predicate = isArray(on)
    ? keyPredicate(tableL, tableR, ...on.map(toArray))
    : parse$2({ on }, { join: [tableL, tableR] }).exprs[0];

  return _join_filter(tableL, tableR, predicate, options);
}

function _lookup(tableL, tableR, [keyL, keyR], { names, exprs, ops }) {
  // instantiate output data
  const cols = columnSet(tableL);
  const total = tableL.totalRows();
  names.forEach(name => cols.add(name, Array(total).fill(NULL)));

  // build lookup table
  const lut = rowLookup(tableR, keyR);

  // generate setter function for lookup match
  const set = unroll(
    ['lr', 'rr', 'data'],
    '{' + concat(names, (_, i) => `_[${i}][lr] = $[${i}](rr, data);`) + '}',
    names.map(name => cols.data[name]),
    aggregateGet(tableR, ops, exprs)
  );

  // find matching rows, set values on match
  const dataR = tableR.data();
  tableL.scan((lrow, data) => {
    const rrow = lut.get(keyL(lrow, data));
    if (rrow >= 0) set(lrow, rrow, dataR);
  });

  return tableL.create(cols);
}

function __lookup(tableL, tableR, on, values) {
  on = inferKeys(tableL, tableR, on);
  return _lookup(
    tableL,
    tableR,
    [ parseKey('lookup', tableL, on[0]), parseKey('lookup', tableR, on[1]) ],
    parse$1('lookup', tableR, values)
  );
}

const opt = (value, defaultValue) => value != null ? value : defaultValue;

function _pivot(table, on, values, options = {}) {
  const { keys, keyColumn } = pivotKeys(table, on, options);
  const vsep = opt(options.valueSeparator, '_');
  const namefn = values.names.length > 1
    ? (i, name) => name + vsep + keys[i]
    : i => keys[i];

  // perform separate aggregate operations for each key
  // if keys do not match, emit NaN so aggregate skips it
  // use custom toString method for proper field resolution
  const results = keys.map(
    k => aggregate(table, values.ops.map(op => {
      if (op.name === 'count') { // fix #273
        const fn = r => k === keyColumn[r] ? 1 : NaN;
        fn.toString = () => k + ':1';
        return { ...op, name: 'sum', fields: [fn] };
      }
      const fields = op.fields.map(f => {
        const fn = (r, d) => k === keyColumn[r] ? f(r, d) : NaN;
        fn.toString = () => k + ':' + f;
        return fn;
      });
      return { ...op, fields };
    }))
  );

  return table.create(output(values, namefn, table.groups(), results));
}

function pivotKeys(table, on, options) {
  const limit = options.limit > 0 ? +options.limit : Infinity;
  const sort = opt(options.sort, true);
  const ksep = opt(options.keySeparator, '_');

  // construct key accessor function
  const get = aggregateGet(table, on.ops, on.exprs);
  const key = get.length === 1
    ? get[0]
    : (row, data) => get.map(fn => fn(row, data)).join(ksep);

  // generate vector of per-row key values
  const kcol = Array(table.totalRows());
  table.scan((row, data) => kcol[row] = key(row, data));

  // collect unique key values
  const uniq = aggregate(
    table.ungroup(),
    [ {
      id: 0,
      name: 'array_agg_distinct',
      fields: [(row => kcol[row])], params: []
    } ]
  )[0][0];

  // get ordered set of unique key values
  const keys = sort ? uniq.sort() : uniq;

  // return key values
  return {
    keys: Number.isFinite(limit) ? keys.slice(0, limit) : keys,
    keyColumn: kcol
  };
}

function output({ names, exprs }, namefn, groups, results) {
  const size = groups ? groups.size : 1;
  const cols = columnSet();
  const m = results.length;
  const n = names.length;

  let result;
  const op = (id, row) => result[id][row];

  // write groupby fields to output
  if (groups) groupOutput(cols, groups);

  // write pivot values to output
  for (let i = 0; i < n; ++i) {
    const get = exprs[i];
    if (get.field != null) {
      // if expression is op only, use aggregates directly
      for (let j = 0; j < m; ++j) {
        cols.add(namefn(j, names[i]), results[j][get.field]);
      }
    } else if (size > 1) {
      // if multiple groups, evaluate expression for each
      for (let j = 0; j < m; ++j) {
        result = results[j];
        const col = cols.add(namefn(j, names[i]), Array(size));
        for (let k = 0; k < size; ++k) {
          col[k] = get(k, null, op);
        }
      }
    } else {
      // if only one group, no need to loop
      for (let j = 0; j < m; ++j) {
        result = results[j];
        cols.add(namefn(j, names[i]), [ get(0, null, op) ]);
      }
    }
  }

  return cols.new();
}

// TODO: enforce aggregates only (no output changes) for values
function __pivot(table, on, values, options) {
  return _pivot(
    table,
    parse$1('fold', table, on),
    parse$1('fold', table, values, { preparse, aggronly: true }),
    options
  );
}

// map direct field reference to "any" aggregate
function preparse(map) {
  map.forEach((value, key) =>
    value.field ? map.set(key, any(value + '')) : 0
  );
}

function __rename(table, columns) {
  const map = new Map();
  table.columnNames(x => (map.set(x, x), 0));
  return _select(table, resolve(table, columns, map));
}

function __rollup(table, values) {
  return _rollup(table, parse$2(values, { table, aggronly: true, window: false }));
}

function sample(buffer, replace, index, weight) {
  return (
    replace
      ? (weight ? sampleRW : sampleRU)
      : (weight ? sampleNW : sampleNU)
  )(buffer.length, buffer, index, weight);
}

// uniform sampling with replacement
// uses straightforward uniform sampling
function sampleRU(size, buffer, index) {
  const n = index.length;
  for (let i = 0; i < size; ++i) {
    buffer[i] = index[(n * random()) | 0];
  }
  return buffer;
}

// weighted sampling with replacement
// uses binary search lookup against cumulative weight
function sampleRW(size, buffer, index, weight) {
  const n = index.length;
  const w = new Float64Array(n);

  let sum = 0;
  for (let i = 0; i < n; ++i) {
    w[i] = (sum += weight(index[i]));
  }

  const bisect = bisector(ascending).right;
  for (let i = 0; i < size; ++i) {
    buffer[i] = index[bisect(w, sum * random())];
  }
  return buffer;
}

// uniform sampling without replacement
// uses reservoir sampling to build out the sample
// https://en.wikipedia.org/wiki/Reservoir_sampling
function sampleNU(size, buffer, index) {
  const n = index.length;
  if (size >= n) return index;

  for (let i = 0; i < size; ++i) {
    buffer[i] = index[i];
  }

  for (let i = size; i < n; ++i) {
    const j = i * random();
    if (j < size) {
      buffer[j | 0] = index[i];
    }
  }

  return buffer;
}

// weighted sample without replacement
// uses method of Efraimidis and Spirakis
// TODO: could use min-heap to improve efficiency
function sampleNW(size, buffer, index, weight) {
  const n = index.length;
  if (size >= n) return index;

  const w = new Float32Array(n);
  const k = new Uint32Array(n);
  for (let i = 0; i < n; ++i) {
    k[i] = i;
    w[i] = -Math.log(random()) / weight(index[i]);
  }

  k.sort((a, b) => w[a] - w[b]);
  for (let i = 0; i < size; ++i) {
    buffer[i] = index[k[i]];
  }
  return buffer;
}

function _shuffle(array, lo = 0, hi = array.length) {
  let n = hi - (lo = +lo);

  while (n) {
    const i = random() * n-- | 0;
    const v = array[n + lo];
    array[n + lo] = array[i + lo];
    array[i + lo] = v;
  }

  return array;
}

function _sample(table, size, weight, options = {}) {
  const { replace, shuffle } = options;
  const parts = table.partitions(false);

  let total = 0;
  size = parts.map((idx, group) => {
    let s = size(group);
    total += (s = (replace ? s : Math.min(idx.length, s)));
    return s;
  });

  const samples = new Uint32Array(total);
  let curr = 0;

  parts.forEach((idx, group) => {
    const sz = size[group];
    const buf = samples.subarray(curr, curr += sz);

    if (!replace && sz === idx.length) {
      // sample size === data size, no replacement
      // no need to sample, just copy indices
      buf.set(idx);
    } else {
      sample(buf, replace, idx, weight);
    }
  });

  if (shuffle !== false && (parts.length > 1 || !replace)) {
    // sampling with replacement methods shuffle, so in
    // that case a single partition is already good to go
    _shuffle(samples);
  }

  return table.reify(samples);
}

function __sample(table, size, options = {}) {
  return _sample(
    table,
    parseSize(table, size),
    parseWeight(table, options.weight),
    options
  );
}

const get = col => row => col.get(row) || 0;

function parseSize(table, size) {
  return isNumber(size)
    ? () => size
    : get(_rollup(table, parse$2({ size }, { table, window: false })).column('size'));
}

function parseWeight(table, w) {
  if (w == null) return null;
  w = isNumber(w) ? table.columnName(w) : w;
  return get(
    isString(w)
      ? table.column(w)
      : _derive(table, parse$2({ w }, { table }), { drop: true }).column('w')
  );
}

function __select(table, columns) {
  return _select(table, resolve(table, columns));
}

function _spread(table, { names, exprs, ops = [] }, options = {}) {
  if (names.length === 0) return table;

  // ignore 'as' if there are multiple field names
  const as = (names.length === 1 && options.as) || [];
  const drop = options.drop == null ? true : !!options.drop;
  const limit = options.limit == null
    ? as.length || Infinity
    : Math.max(1, +options.limit || 1);

  const get = aggregateGet(table, ops, exprs);
  const cols = columnSet();
  const map = names.reduce((map, name, i) => map.set(name, i), new Map());

  const add = (index, name) => {
    const columns = spread(table, get[index], limit);
    const n = columns.length;
    for (let i = 0; i < n; ++i) {
      cols.add(as[i] || `${name}_${i + 1}`, columns[i]);
    }
  };

  table.columnNames().forEach(name => {
    if (map.has(name)) {
      if (!drop) cols.add(name, table.column(name));
      add(map.get(name), name);
      map.delete(name);
    } else {
      cols.add(name, table.column(name));
    }
  });

  map.forEach(add);

  return table.create(cols);
}

function spread(table, get, limit) {
  const nrows = table.totalRows();
  const columns = [];

  table.scan((row, data) => {
    const values = toArray(get(row, data));
    const n = Math.min(values.length, limit);
    while (columns.length < n) {
      columns.push(Array(nrows).fill(NULL));
    }
    for (let i = 0; i < n; ++i) {
      columns[i][row] = values[i];
    }
  });

  return columns;
}

function __spread(table, values, options) {
  return _spread(table, parse$1('spread', table, values), options);
}

function __union(table, others) {
  return table.concat(others).dedupe();
}

function __unroll(table, values, options) {
  return _unroll(
    table,
    parse$1('unroll', table, values),
    options && options.drop
      ? { ...options, drop: parse$1('unroll', table, options.drop).names }
      : options
  );
}

function _groupby(table, exprs) {
  return table.create({
    groups: createGroups(table, exprs)
  });
}

function createGroups(table, { names = [], exprs = [], ops = [] }) {
  const n = names.length;
  if (n === 0) return null;

  // check for optimized path when grouping by a single field
  // use pre-calculated groups if available
  if (n === 1 && !table.isFiltered() && exprs[0].field) {
    const col = table.column(exprs[0].field);
    if (col.groups) return col.groups(names);
  }

  let get = aggregateGet(table, ops, exprs);
  const getKey = keyFunction(get);
  const nrows = table.totalRows();
  const keys = new Uint32Array(nrows);
  const index = {};
  const rows = [];

  // inline table scan for performance
  const data = table.data();
  const bits = table.mask();
  if (bits) {
    for (let i = bits.next(0); i >= 0; i = bits.next(i + 1)) {
      const key = getKey(i, data) + '';
      const val = index[key];
      keys[i] = val != null ? val : (index[key] = rows.push(i) - 1);
    }
  } else {
    for (let i = 0; i < nrows; ++i) {
      const key = getKey(i, data) + '';
      const val = index[key];
      keys[i] = val != null ? val : (index[key] = rows.push(i) - 1);
    }
  }

  if (!ops.length) {
    // capture data in closure, so no interaction with select
    get = get.map(f => row => f(row, data));
  }

  return { keys, get, names, rows, size: rows.length };
}

function __groupby(table, values) {
  return _groupby(table, parse$1('groupby', table, values));
}

function _orderby(table, comparator) {
  return table.create({ order: comparator });
}

// generate code to compare a single field
const _compare = (u, v, lt, gt) =>
  `((u = ${u}) < (v = ${v}) || u == null) && v != null ? ${lt}
    : (u > v || v == null) && u != null ? ${gt}
    : ((v = v instanceof Date ? +v : v), (u = u instanceof Date ? +u : u)) !== u && v === v ? ${lt}
    : v !== v && u === u ? ${gt} : `;

function parse(table, fields) {
  // parse expressions, generate code for both a and b values
  const names = [];
  const exprs = [];
  const fn = [];
  let keys = null, opA = '0', opB = '0';
  if (table.isGrouped()) {
    keys = table.groups().keys;
    opA = 'ka';
    opB = 'kb';
  }
  const { ops } = parse$2(fields, {
    table,
    value: (name, node) => {
      names.push(name);
      if (node.escape) {
        // if an escaped function, invoke it directly
        const f = i => `fn[${fn.length}](${i}, data)`;
        exprs.push([f('a'), f('b')]);
        fn.push(node.escape);
      } else {
        // generate code to extract values to compare
        exprs.push([
          codegen(node, { index: 'a', op: opA }),
          codegen(node, { index: 'b', op: opB })
        ]);
      }
    },
    window: false
  });

  // calculate aggregate values if needed
  const result = aggregate(table, ops);
  const op = (id, row) => result[id][row];

  // generate comparison code for each field
  const n = names.length;
  let code = 'return (a, b) => {'
    + (op && table.isGrouped() ? 'const ka = keys[a], kb = keys[b];' : '')
    + 'let u, v; return ';
  for (let i = 0; i < n; ++i) {
    const o = fields.get(names[i]).desc ? -1 : 1;
    const [u, v] = exprs[i];
    code += _compare(u, v, -o, o);
  }
  code += '0;};';

  // instantiate and return comparator function
  return Function('op', 'keys', 'fn', 'data', code)(op, keys, fn, table.data());
}

function __orderby(table, values) {
  return _orderby(table, parseValues(table, values));
}

function parseValues(table, params) {
  let index = -1;
  const exprs = new Map();
  const add = val => exprs.set(++index + '', val);

  params.forEach(param => {
    const expr = param.expr != null ? param.expr : param;

    if (isObject(expr) && !isFunction(expr)) {
      for (const key in expr) add(expr[key]);
    } else {
      add(
        isNumber(expr) ? field(param, table.columnName(expr))
          : isString(expr) ? field(param)
          : isFunction(expr) ? param
          : error(`Invalid orderby field: ${param+''}`)
      );
    }
  });

  return parse(table, exprs);
}

function __concat(table, others) {
  const trows = table.numRows();
  const nrows = trows + others.reduce((n, t) => n + t.numRows(), 0);
  if (trows === nrows) return table;

  const tables = [table, ...others];
  const cols = columnSet();

  table.columnNames().forEach(name => {
    const arr = Array(nrows);
    let row = 0;
    tables.forEach(table => {
      const col = table.column(name) || { get: () => NULL };
      table.scan(trow => arr[row++] = col.get(trow));
    });
    cols.add(name, arr);
  });

  return table.create(cols.new());
}

function __reduce(table, reducer) {
  const cols = columnSet();
  const groups = table.groups();

  // initialize groups
  const { get, names = [], rows, size = 1 } = groups || {};
  const counts = new Uint32Array(size + 1);
  names.forEach(name => cols.add(name, null));

  // compute reduced values
  const cells = groups
    ? reduceGroups(table, reducer, groups)
    : [ reduceFlat(table, reducer) ];

  // initialize output columns
  reducer.outputs().map(name => cols.add(name, []));

  // write reduced values to output columns
  const n = counts.length - 1;
  let len = 0;
  for (let i = 0; i < n; ++i) {
    len += counts[i + 1] = reducer.write(cells[i], cols.data, counts[i]);
  }

  // write group values to output columns
  if (groups) {
    const data = table.data();
    names.forEach((name, index) => {
      const column = cols.data[name] = Array(len);
      const getter = get[index];
      for (let i = 0, j = 0; i < size; ++i) {
        column.fill(getter(rows[i], data), j, j += counts[i + 1]);
      }
    });
  }

  return table.create(cols.new());
}

function __ungroup(table) {
  return table.isGrouped()
    ? table.create({ groups: null })
    : table;
}

function __unorder(table) {
  return table.isOrdered()
    ? table.create({ order: null })
    : table;
}

var verbs = {
  __antijoin: (table, other, on) =>
    __semijoin(table, other, on, { anti: true }),
  __count: (table, options = {}) =>
    __rollup(table, { [options.as || 'count']: count() }),
  __cross: (table, other, values, options) =>
    __join(table, other, () => true, values, {
      ...options, left: true, right: true
    }),
  __concat,
  __dedupe,
  __derive,
  __except,
  __filter,
  __fold,
  __impute,
  __intersect,
  __join,
  __lookup,
  __pivot,
  __relocate,
  __rename,
  __rollup,
  __sample,
  __select,
  __semijoin,
  __spread,
  __union,
  __unroll,
  __groupby,
  __orderby,
  __ungroup,
  __unorder,
  __reduce
};

// Add verb implementations to ColumnTable prototype
Object.assign(ColumnTable.prototype, verbs);

/**
 * Create a new table for a set of named columns.
 * @param {object|Map} columns
 *  The set of named column arrays. Keys are column names.
 *  The enumeration order of the keys determines the column indices,
 *  unless the names parameter is specified.
 *  Values must be arrays (or array-like values) of identical length.
 * @param {string[]} [names] Ordered list of column names. If specified,
 *  this array determines the column indices. If not specified, the
 *  key enumeration order of the columns object is used.
 * @return {ColumnTable} the instantiated table
 * @example table({ colA: ['a', 'b', 'c'], colB: [3, 4, 5] })
 */
function table(columns, names) {
  return ColumnTable.new(columns, names);
}

/**
 * Create a new table from an existing object, such as an array of
 * objects or a set of key-value pairs.
 * @param {object|Array|Map} values Data values to populate the table.
 *  If array-valued or iterable, imports rows for each non-null value,
 *  using the provided column names as keys for each row object. If no
 *  names are provided, the first non-null object's own keys are used.
 *  If object- or Map-valued, create columns for the keys and values.
 * @param {string[]} [names] Column names to include.
 *  For object or Map values, specifies the key and value column names.
 *  Otherwise, specifies the keys to look up on each row object.
 * @return {ColumnTable} the instantiated table.
 * @example from([ { colA: 1, colB: 2 }, { colA: 3, colB: 4 } ])
 */
function from(values, names) {
  return ColumnTable.from(values, names);
}

/**
 * Options for binning number values.
 * @typedef {object} BinOptions
 * @property {number} [maxbins] The maximum number of bins.
 * @property {number} [minstep] The minimum step size between bins.
 * @property {number} [step] The exact step size to use between bins.
 *  If specified, the maxbins and minstep options are ignored.
 * @property {boolean} [nice=true] Flag indicating if bins should
 *  snap to "nice" human-friendly values such as multiples of ten.
 * @property {number} [offset=0] Step offset for bin boundaries.
 *  The default floors to the lower bin boundary. A value of 1 snaps
 *  one step higher to the upper bin boundary, and so on.
 */

/**
 * Generate a table expression that performs uniform binning of
 * number values. The resulting string can be used as part of the
 * input to table transformation verbs.
 * @param {string} name The name of the column to bin.
 * @param {BinOptions} [options] Binning scheme options.
 * @return {string} A table expression string for binned values.
 * @example bin('colA', { maxbins: 20 })
 */
function bin(name, options = {}) {
  const field = `d[${JSON.stringify(name)}]`;
  const { maxbins, nice, minstep, step, offset } = options;
  const args = [maxbins, nice, minstep, step];

  let n = args.length;
  while (n && args[--n] == null) args.pop();
  const a = args.length ? ', ' + args.map(a => a + '').join(', ') : '';

  return `d => op.bin(${field}, ...op.bins(${field}${a}), ${offset || 0})`;
}

/**
 * Escape a function or value to prevent it from being parsed and recompiled.
 * This helper can be used in lieu of single-table table expressions (which
 * are internally parsed and rewritten) to apply a JavaScript function as-is,
 * including support for closures. It can also be used to pass a constant,
 * literal value as a table expression, bypassing the parser.
 * @param {*} value A function or value to escape.
 * @return {object} A wrapper object representing the escaped value.
 * @example escape(d => d.a.toFixed(2))
 * @example escape(d => d.a * -d.b)
 */
function escape(value) {
  return wrap(value, {
    escape: true,
    toString() { error('Escaped values can not be serialized.'); }
  });
}

/**
 * Generate a table expression that computes the number of rows
 * corresponding to a given fraction for each group. The resulting
 * string can be used as part of the input to the sample verb.
 * @param {number} fraction The fractional value.
 * @return {string} A table expression string for computing row counts.
 * @example frac(0.5)
 */
function frac(fraction) {
  return `() => op.round(${+fraction} * op.count())`;
}

/**
 * Select columns by index and rename them to the provided names. Returns a
 * selection helper function that takes a table as input and produces a
 * rename map as output. If the number of provided names is less than the
 * number of table columns, the rename map will only include entries for the
 * provided names. If the number of table columns is less than then number of
 * provided names, only the rename map will only include entries that cover
 * the existing columns.
 * @param {...(string|string[])} names An ordered list of column names.
 * @return {Function} Selection function compatible with {@link Table#select}.
 * @example table.rename(aq.names('a', 'b', 'c'))
 * @example table.select(aq.names(['a', 'b', 'c']))
 */
function names(...names) {
  names = names.flat();
  return table => {
    const m = new Map();
    const n = Math.min(names.length, table.numCols());
    for (let i = 0; i < n; ++i) {
      m.set(table.columnName(i), names[i]);
    }
    return m;
  };
}

/**
 * Convenience function for computing a single aggregate value for
 * a table. Equivalent to ungrouping a table, applying a rollup verb
 * for a single aggregate, and extracting the resulting value.
 * @param {Table} table A table instance.
 * @param {import('../../table/transformable').TableExpr} expr An
 *   aggregate table expression to evaluate.
 * @return {import('../../table/table').DataValue} The aggregate value.
 * @example agg(table, op.max('colA'))
 * @example agg(table, d => [op.min('colA'), op.max('colA')])
 */
function agg(table, expr) {
  return table.ungroup().rollup({ _: expr }).get('_');
}

const onIllegal = (name, type) =>
  error(`Illegal ${type} name: ${toString(name)}`);

const onDefined = (name, type) =>
  error(`The ${type} ${toString(name)} is already defined. Use override option?`);

const onReserve = (name, type) =>
  error(`The ${type} name ${toString(name)} is reserved and can not be overridden.`);

function check(name, options, obj = ops, type = 'function') {
  if (!name) onIllegal(name, type);
  if (!options.override && has(obj, name)) onDefined(name, type);
}

// -- Op Functions --------------------------------------------------

function verifyFunction(name, def, object, options) {
  return object[name] === def || check(name, options);
}

/**
 * Register an aggregate or window operation.
 * @param {string} name The name of the operation
 * @param {AggregateDef|WindowDef} def The operation definition.
 * @param {object} object The registry object to add the definition to.
 * @param {RegisterOptions} [options] Registration options.
 */
function addOp(name, def, object, options = {}) {
  if (verifyFunction(name, def, object, options)) return;
  const [nf = 0, np = 0] = def.param;
  object[name] = def;
  ops[name] = (...params) => op(
    name,
    params.slice(0, nf),
    params.slice(nf, nf + np)
  );
}

/**
 * Register a custom aggregate function.
 * @param {string} name The name to use for the aggregate function.
 * @param {AggregateDef} def The aggregate operator definition.
 * @param {RegisterOptions} [options] Function registration options.
 * @throws If a function with the same name is already registered and
 *  the override option is not specified.
 */
function addAggregateFunction(name, def, options) {
  addOp(name, def, aggregateFunctions, options);
}

/**
 * Register a custom window function.
 * @param {string} name The name to use for the window function.
 * @param {WindowDef} def The window operator definition.
 * @param {RegisterOptions} [options] Function registration options.
 * @throws If a function with the same name is already registered and
 *  the override option is not specified.
 */
function addWindowFunction(name, def, options) {
  addOp(name, def, windowFunctions, options);
}

/**
 * Register a function for use within table expressions.
 * If only a single argument is provided, it will be assumed to be a
 * function and the system will try to extract its name.
 * @param {string} name The name to use for the function.
 * @param {Function} fn A standard JavaScript function.
 * @param {RegisterOptions} [options] Function registration options.
 * @throws If a function with the same name is already registered and
 *  the override option is not specified, or if no name is provided
 *  and the input function is anonymous.
 */
function addFunction(name, fn, options = {}) {
  if (arguments.length === 1) {
    fn = name;
    name = fn.name;
    if (name === '' || name === 'anonymous') {
      error('Anonymous function provided, please include a name argument.');
    } else if (name === ROW_OBJECT) {
      onReserve(ROW_OBJECT, 'function');
    }
  }
  if (verifyFunction(name, fn, functions, options)) return;
  functions[name] = fn;
  ops[name] = fn;
}

// -- Table Methods and Verbs ---------------------------------------

const proto = ColumnTable.prototype;

/**
 * Reserved table/query methods that must not be overwritten.
 */
let RESERVED;

function addReserved(obj) {
  for (; obj; obj = Object.getPrototypeOf(obj)) {
    Object.getOwnPropertyNames(obj).forEach(name => RESERVED[name] = 1);
  }
}

function verifyTableMethod(name, fn, options) {
  const type = 'method';

  // exit early if duplicate re-assignment
  if (proto[name] && proto[name].fn === fn) return true;

  // initialize reserved properties to avoid overriding internals
  if (!RESERVED) {
    RESERVED = {};
    addReserved(proto);
    addReserved(Query.prototype);
  }

  // perform name checks
  if (RESERVED[name]) onReserve(name, type);
  if ((name + '')[0] === '_') onIllegal(name, type);
  check(name, options, proto, type);
}

/**
 * Register a new table method. A new method will be added to the column
 * table prototype. When invoked from a table, the registered method will
 * be invoked with the table as the first argument, followed by all the
 * provided arguments.
 * @param {string} name The name of the table method.
 * @param {Function} method The table method.
 * @param {RegisterOptions} options
 */
function addTableMethod(name, method, options = {}) {
  if (verifyTableMethod(name, method, options)) return;
  proto[name] = function(...args) { return method(this, ...args); };
  proto[name].fn = method;
}

/**
 * Register a new transformation verb.
 * @param {string} name The name of the verb.
 * @param {Function} method The verb implementation.
 * @param {ParamDef[]} params The verb parameter schema.
 * @param {RegisterOptions} options Function registration options.
 */
function addVerb(name, method, params, options = {}) {
  // register table method first
  // if that doesn't throw, add serializable verb entry
  addTableMethod(name, method, options);
  addQueryVerb(name, Verbs[name] = createVerb(name, params));
}

// -- Package Bundles -----------------------------------------------

const PACKAGE = 'arquero_package';

/**
 * Add an extension package of functions, table methods, and/or verbs.
 * @param {Package|PackageBundle} bundle The package of extensions.
 * @throws If package validation fails.
 */
function addPackage(bundle, options = {}) {
  const pkg = bundle && bundle[PACKAGE] || bundle;
  const parts = {
    functions: [
      (name, def, opt) => verifyFunction(name, def, functions, opt),
      addFunction
    ],
    aggregateFunctions: [
      (name, def, opt) => verifyFunction(name, def, aggregateFunctions, opt),
      addAggregateFunction
    ],
    windowFunctions: [
      (name, def, opt) => verifyFunction(name, def, windowFunctions, opt),
      addWindowFunction
    ],
    tableMethods: [
      verifyTableMethod,
      addTableMethod
    ],
    verbs: [
      (name, obj, opt) => verifyTableMethod(name, obj.method, opt),
      (name, obj, opt) => addVerb(name, obj.method, obj.params, opt)
    ]
  };

  function scan(index) {
    for (const key in parts) {
      const part = parts[key];
      const p = pkg[key];
      for (const name in p) part[index](name, p[name], options);
    }
  }
  scan(0); // first validate package, throw if validation fails
  scan(1); // then add package content
}

/**
 * Aggregate function definition.
 * @typedef {import('./op/aggregate-functions').AggregateDef} AggregateDef
 */

/**
 * Window function definition.
 * @typedef {import('./op/window-functions').WindowDef} WindowDef
 */

/**
 * Verb parameter definition.
 * @typedef {import('./query/verb').ParamDef} ParamDef
 */

/**
 * Verb definition.
 * @typedef {object} VerbDef
 * @property {Function} method A function implementing the verb.
 * @property {ParamDef[]} params The verb parameter schema.
 */

/**
 * Verb parameter definition.
 * @typedef {object} ParamDef
 * @property {string} name The verb parameter name.
 * @property {ParamType} type The verb parameter type.
 */

/**
 * A package of op function and table method definitions.
 * @typedef {object} Package
 * @property {{[name: string]: Function}} [functions] Standard function entries.
 * @property {{[name: string]: AggregateDef}} [aggregateFunctions] Aggregate function entries.
 * @property {{[name: string]: WindowDef}} [windowFunctions] Window function entries.
 * @property {{[name: string]: Function}} [tableMethods] Table method entries.
 * @property {{[name: string]: VerbDef}} [verbs] Verb entries.
 */

/**
 * An object containing an extension package.
 * @typedef {object} PackageBundle
 * @property {Package} arquero.package The package bundle.
 */

/**
 * Options for registering new functions.
 * @typedef {object} RegisterOptions
 * @property {boolean} [override=false] Flag indicating if the added
 *  function can override an existing function with the same name.
 */

// export internal class definitions

const internal = {
  Table,
  ColumnTable,
  Transformable,
  Query,
  Reducer,
  Verb,
  Verbs,
  columnFactory,
  parse: parse$2,
  walk_ast: walk
};
const version = pkg.version;

/**
 * Options for file loading.
 * @typedef {object} LoadOptions
 * @property {'arrayBuffer'|'text'|'json'} [as='text'] A string indicating
 *  the data type of the file. One of 'arrayBuffer', 'json', or 'text'.
 * @property {(data: *, options?: object) => ColumnTable} [using] A function
 *  that accepts a data payload (e.g., string or buffer) and an options object
 *  as input and returns an Arquero table (such as fromCSV or fromJSON).
 * @property {object} [fetch] Options to pass to the HTTP fetch method
 *  when loading a URL.
 */

/**
 * Load data from a file and return a Promise for an Arquero table.
 * A specific format parser can be provided with the *using* option,
 * otherwise CSV format is assumed. The options to this method are
 * passed as the second argument to the format parser.
 * @param {string} path The URL or file path to load.
 * @param {LoadOptions & object} options The loading and formatting options.
 * @return {Promise<ColumnTable>} A Promise for an Arquero table.
 * @example aq.load('data/table.csv')
 * @example aq.load('data/table.json', { using: aq.fromJSON })
 * @example aq.load('data/table.json', { using: aq.from })
 */
function load(path, options = {}) {
  return (/^([A-Za-z]+:)?\/\//.test(path) && !path.startsWith('file://')
    ? loadURL
    : loadFile)(path, options, options.using || fromCSV);
}

function loadURL(url, options, parse) {
  return fetch(url, options.fetch)
    .then(res => res[options.as || 'text']())
    .then(data => parse(data, options));
}

function loadFile(file, options, parse) {
  file = file.startsWith('file://') ? new URL(file) : file;
  return new Promise((accept, reject) => {
    const enc = options.as !== 'arrayBuffer' ? 'utf8' : null;
    fs.readFile(file, enc, (error, data) => {
      if (error) {
        reject(error);
      } else try {
        if (options.as === 'json') data = JSON.parse(data);
        accept(parse(data, options));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Load an Arrow file from a URL and return a Promise for an Arquero table.
 * @param {string} path The URL or file path to load.
 * @param {LoadOptions & import('./from-arrow').ArrowOptions} options Arrow format options.
 * @return {Promise<ColumnTable>} A Promise for an Arquero table.
 * @example aq.loadArrow('data/table.arrow')
 */
function loadArrow(path, options) {
  return load(path, { ...options, as: 'arrayBuffer', using: fromArrow });
}

/**
 * Load a CSV file from a URL and return a Promise for an Arquero table.
 * @param {string} path The URL or file path to load.
 * @param {LoadOptions & import('./from-csv').CSVParseOptions} options CSV format options.
 * @return {Promise<ColumnTable>} A Promise for an Arquero table.
 * @example aq.loadCSV('data/table.csv')
 * @example aq.loadTSV('data/table.tsv', { delimiter: '\t' })
 */
function loadCSV(path, options) {
  return load(path, { ...options, as: 'text', using: fromCSV });
}

/**
 * Load a fixed width file from a URL and return a Promise for an Arquero table.
 * @param {string} path The URL or file path to load.
 * @param {LoadOptions & import('./from-fixed').FixedParseOptions} options Fixed width format options.
 * @return {Promise<ColumnTable>} A Promise for an Arquero table.
 * @example aq.loadFixedWidth('data/table.txt', { names: ['name', 'city', state'], widths: [10, 20, 2] })
 */
 function loadFixed(path, options) {
  return load(path, { ...options, as: 'text', using: fromFixed });
}

/**
 * Load a JSON file from a URL and return a Promise for an Arquero table.
 * If the loaded JSON is array-valued, an array-of-objects format is assumed
 * and the aq.from method is used to construct the table. Otherwise, a
 * column object format is assumed and aq.fromJSON is applied.
 * @param {string} path The URL or file path to load.
 * @param {LoadOptions & import('./from-json').JSONParseOptions} options JSON format options.
 * @return {Promise<ColumnTable>} A Promise for an Arquero table.
 * @example aq.loadJSON('data/table.json')
 */
function loadJSON(path, options) {
  return load(path, { ...options, as: 'json', using: parseJSON });
}

function parseJSON(data, options) {
  return isArray(data) ? from(data) : fromJSON(data, options);
}

exports.addAggregateFunction = addAggregateFunction;
exports.addFunction = addFunction;
exports.addPackage = addPackage;
exports.addTableMethod = addTableMethod;
exports.addVerb = addVerb;
exports.addWindowFunction = addWindowFunction;
exports.agg = agg;
exports.all = all;
exports.bin = bin;
exports.desc = desc;
exports.endswith = endswith;
exports.escape = escape;
exports.field = field;
exports.frac = frac;
exports.from = from;
exports.fromArrow = fromArrow;
exports.fromCSV = fromCSV;
exports.fromFixed = fromFixed;
exports.fromJSON = fromJSON;
exports.internal = internal;
exports.load = load;
exports.loadArrow = loadArrow;
exports.loadCSV = loadCSV;
exports.loadFixed = loadFixed;
exports.loadJSON = loadJSON;
exports.matches = matches;
exports.names = names;
exports.not = not;
exports.op = ops;
exports.query = query;
exports.queryFrom = queryFrom;
exports.range = range;
exports.rolling = rolling;
exports.seed = seed;
exports.startswith = startswith;
exports.table = table;
exports.toArrow = toArrow;
exports.version = version;
