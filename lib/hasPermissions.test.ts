import { graphql, GraphQLResolveInfo, GraphQLSchema } from 'graphql';
import { print } from 'graphql/language/printer';
import gql from 'graphql-tag';
import { makeExecutableSchema } from 'graphql-tools';
import { ForbiddenError } from 'apollo-server-errors';

import {
  debugFilterMissingPermissions,
  debugGetErrorMessage,
  HasPermissionsDirectiveVisitor,
  prodFilterMissingPermissions,
  prodGetErrorMessage,
} from './hasPermissions';

describe('@hasPermissions()', (): void => {
  const name = 'hasPermissions';
  const directiveTypeDefs = HasPermissionsDirectiveVisitor.getTypeDefs(name);

  it('exports correct typeDefs', (): void => {
    expect(directiveTypeDefs.map(print)).toEqual([
      `\
"""ensures it has permissions before calling the resolver"""
directive @${name}(
  """All permissions required by this field (or object). All must be fulfilled"""
  permissions: [String!]!
  """How to handle missing permissions"""
  policy: HasPermissionsDirectivePolicy = THROW
) on OBJECT | FIELD_DEFINITION
`,
      `\
enum HasPermissionsDirectivePolicy {
  """Field resolver is responsible to evaluate it using \`missingPermissions\` injected argument"""
  RESOLVER
  """Field resolver is not called if permissions are missing, it throws \`ForbiddenError\`"""
  THROW
}
`,
    ]);
  });

  it('defaultName is correct', (): void => {
    expect(directiveTypeDefs.map(print)).toEqual(
      HasPermissionsDirectiveVisitor.getTypeDefs().map(print),
    );
  });

  const grantedPermissions = ['x', 'y', 'z'];

  describe('filterMissingPermissions', (): void => {
    const requiredPermissions = ['x', 'y', 'z'];
    describe('debugFilterMissingPermissions()', (): void => {
      it('returns all if nothing is granted', (): void => {
        expect(
          debugFilterMissingPermissions(undefined, requiredPermissions),
        ).toBe(requiredPermissions);
      });
      it('returns all missing', (): void => {
        expect(
          debugFilterMissingPermissions(new Set(['x']), requiredPermissions),
        ).toEqual(['y', 'z']);
      });
      it('returns null if all granted', (): void => {
        expect(
          debugFilterMissingPermissions(
            new Set(requiredPermissions),
            requiredPermissions,
          ),
        ).toBe(null);
      });
    });

    describe('prodFilterMissingPermissions()', (): void => {
      it('returns all if nothing is granted', (): void => {
        expect(
          prodFilterMissingPermissions(undefined, requiredPermissions),
        ).toBe(requiredPermissions);
      });
      it('returns first missing', (): void => {
        expect(
          prodFilterMissingPermissions(new Set(['x']), requiredPermissions),
        ).toEqual(['y']);
      });
      it('returns null if all granted', (): void => {
        expect(
          prodFilterMissingPermissions(
            new Set(requiredPermissions),
            requiredPermissions,
          ),
        ).toBe(null);
      });
    });
  });

  describe('getErrorMessage', (): void => {
    it('debugGetErrorMessage() is verbose', (): void => {
      expect(debugGetErrorMessage(['x', 'y'])).toBe(
        'Missing Permissions: x, y',
      );
    });
    it('prodGetErrorMessage() is terse', (): void => {
      expect(prodGetErrorMessage()).toBe('Missing Permissions');
    });
  });

  describe('createDirectiveContext()', (): void => {
    it('supports list of permissions', (): void => {
      const ctx = HasPermissionsDirectiveVisitor.createDirectiveContext({
        filterMissingPermissions: debugFilterMissingPermissions,
        grantedPermissions,
      });
      expect(
        ctx.checkMissingPermissions(
          ['x'],
          'ck1',
          {},
          {},
          {},
          {} as GraphQLResolveInfo,
        ),
      ).toBe(null);

      const cacheKey = 'ck2';
      const missingPermissions = ctx.checkMissingPermissions(
        ['a', 'b'],
        cacheKey,
        {},
        {},
        {},
        {} as GraphQLResolveInfo,
      );
      expect(missingPermissions).toEqual(['a', 'b']);
      expect(
        ctx.checkMissingPermissions(
          ['a', 'b'],
          cacheKey,
          {},
          {},
          {},
          {} as GraphQLResolveInfo,
        ),
      ).toBe(missingPermissions); // cache must return the same list!
    });

    it('supports no granted permission', (): void => {
      const ctx = HasPermissionsDirectiveVisitor.createDirectiveContext({
        filterMissingPermissions: debugFilterMissingPermissions,
        grantedPermissions: undefined,
      });
      expect(
        ctx.checkMissingPermissions(
          ['x', 'y'],
          'ck1',
          {},
          {},
          {},
          {} as GraphQLResolveInfo,
        ),
      ).toEqual(['x', 'y']);
    });

    it('use default filterMissingPermissions', (): void => {
      const ctx = HasPermissionsDirectiveVisitor.createDirectiveContext({
        grantedPermissions: undefined,
      });
      expect(
        ctx.checkMissingPermissions(
          ['x', 'y'],
          'ck1',
          {},
          {},
          {},
          {} as GraphQLResolveInfo,
        ),
      ).toContain('x');
    });
  });

  describe('HasPermissionsDirectiveVisitor', (): void => {
    describe('works on object field', (): void => {
      const schema = makeExecutableSchema({
        resolvers: {
          SomeObject: {
            email: ({ email }, { missingPermissions }): string => {
              if (missingPermissions) {
                const [user, domain] = email.split('@');
                return `${user[0]}${'*'.repeat(user.length - 1)}@${domain}`;
              }
              return email;
            },
          },
        },
        schemaDirectives: {
          [name]: HasPermissionsDirectiveVisitor,
        },
        typeDefs: [
          ...directiveTypeDefs,
          gql`
            type SomeObject {
              onlyAllowedMayRead: Int @${name}(permissions: ["x", "y"])
              email(missingPermissions: [String!]): String
                @${name}(permissions: ["x"], policy: RESOLVER)
              publicField: String
              alsoPublic: String @${name}(permissions: [])
            }
            type Query {
              test: SomeObject
            }
          `,
        ],
      });
      const source = print(gql`
        query {
          test {
            onlyAllowedMayRead
            email
            publicField
            alsoPublic
          }
        }
      `);
      const rootValue = {
        test: {
          alsoPublic: 'world',
          email: 'user@server.com',
          onlyAllowedMayRead: 42,
          publicField: 'hello',
        },
      };

      it('if hasPermissions, returns all', async (): Promise<void> => {
        const context = HasPermissionsDirectiveVisitor.createDirectiveContext({
          filterMissingPermissions: debugFilterMissingPermissions,
          grantedPermissions,
        });
        const result = await graphql(schema, source, rootValue, context);
        expect(result).toEqual({
          data: rootValue,
        });
      });

      it('if NOT hasPermissions, returns partial', async (): Promise<void> => {
        const context = HasPermissionsDirectiveVisitor.createDirectiveContext({
          filterMissingPermissions: debugFilterMissingPermissions,
          grantedPermissions: undefined,
        });
        const result = await graphql(schema, source, rootValue, context);
        expect(result).toEqual({
          data: {
            test: {
              alsoPublic: rootValue.test.alsoPublic,
              email: 'u***@server.com',
              onlyAllowedMayRead: null,
              publicField: rootValue.test.publicField,
            },
          },
          errors: [new ForbiddenError('Missing Permissions: x, y')],
        });
      });
    });

    describe('works on whole object', (): void => {
      const schema = makeExecutableSchema({
        schemaDirectives: {
          [name]: HasPermissionsDirectiveVisitor,
        },
        typeDefs: [
          ...directiveTypeDefs,
          gql`
            type MyRestrictedObject @${name}(permissions: ["x"]) {
              restrictedField: Int # behaves as @hasPermissions(permissions: ["x"])
              anotherRestrictedField: String # behaves as @hasPermissions(permissions: ["x"])
              restrictedTwice: Int @${name}(permissions: ["y"])
            }
            type Query {
              test: MyRestrictedObject
            }
          `,
        ],
      });
      const source = print(gql`
        query {
          test {
            restrictedField
            anotherRestrictedField
            restrictedTwice
          }
        }
      `);
      const rootValue = {
        test: {
          anotherRestrictedField: 'hello',
          restrictedField: 42,
          restrictedTwice: 123,
        },
      };

      it('if hasPermissions, returns all', async (): Promise<void> => {
        const context = HasPermissionsDirectiveVisitor.createDirectiveContext({
          filterMissingPermissions: debugFilterMissingPermissions,
          grantedPermissions,
        });
        const result = await graphql(schema, source, rootValue, context);
        expect(result).toEqual({
          data: rootValue,
        });
      });

      it('if NOT hasPermissions, returns partial', async (): Promise<void> => {
        const context = HasPermissionsDirectiveVisitor.createDirectiveContext({
          filterMissingPermissions: debugFilterMissingPermissions,
          grantedPermissions: undefined,
        });
        const result = await graphql(schema, source, rootValue, context);
        expect(result).toEqual({
          data: {
            test: {
              anotherRestrictedField: null,
              restrictedField: null,
              restrictedTwice: null,
            },
          },
          errors: [
            new ForbiddenError('Missing Permissions: x'),
            new ForbiddenError('Missing Permissions: x'),
            new ForbiddenError('Missing Permissions: y'),
          ],
        });
      });

      it('combined hasPermissions', async (): Promise<void> => {
        const context = HasPermissionsDirectiveVisitor.createDirectiveContext({
          filterMissingPermissions: debugFilterMissingPermissions,
          grantedPermissions: ['x'],
        });
        const result = await graphql(schema, source, rootValue, context);
        expect(result).toEqual({
          data: {
            test: {
              anotherRestrictedField: rootValue.test.anotherRestrictedField,
              restrictedField: rootValue.test.restrictedField,
              restrictedTwice: null,
            },
          },
          errors: [new ForbiddenError('Missing Permissions: y')],
        });
      });

      it('combined hasPermissions 2', async (): Promise<void> => {
        const context = HasPermissionsDirectiveVisitor.createDirectiveContext({
          filterMissingPermissions: debugFilterMissingPermissions,
          grantedPermissions: ['y'],
        });
        const result = await graphql(schema, source, rootValue, context);
        expect(result).toEqual({
          data: {
            test: {
              anotherRestrictedField: null,
              restrictedField: null,
              restrictedTwice: null,
            },
          },
          errors: [
            new ForbiddenError('Missing Permissions: x'),
            new ForbiddenError('Missing Permissions: x'),
            new ForbiddenError('Missing Permissions: x'),
          ],
        });
      });
    });
  });

  it('throws if missingPermissions argument type is wrong', (): void => {
    expect(
      (): GraphQLSchema =>
        makeExecutableSchema({
          schemaDirectives: {
            [name]: HasPermissionsDirectiveVisitor,
          },
          typeDefs: [
            ...directiveTypeDefs,
            gql`
              type SomeObject {
                email(missingPermissions: Boolean): String
                  @${name}(permissions: ["x"], policy: RESOLVER)
              }
            `,
          ],
        }),
    ).toThrow();
  });
});